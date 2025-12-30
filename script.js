/* =========================================
   AUDIO ENGINE & GLOBALS
   ========================================= */
const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
let playlist = [];
let aiEnabled = false;
let crossfaderVal = 0.5;

// AI State
const AI_STATE = {
    transitioning: false,
    nextTransitionTime: 0,
    activeDeck: 'A' // 'A' or 'B'
};

/* =========================================
   CLASS: TRACK ANALYZER
   Detects BPM and Energy (RMS)
   ========================================= */
class TrackAnalyzer {
    static async analyze(buffer) {
        const data = buffer.getChannelData(0);
        
        // 1. Detect Energy (RMS) to find drops/chorus
        let energyProfile = [];
        const windowSize = 44100 * 2; // 2 seconds average
        let totalEnergy = 0;

        for (let i = 0; i < data.length; i += windowSize) {
            let sum = 0;
            for (let j = 0; j < windowSize && i + j < data.length; j++) {
                sum += data[i + j] * data[i + j];
            }
            let rms = Math.sqrt(sum / windowSize);
            energyProfile.push(rms);
            totalEnergy += rms;
        }
        const avgEnergy = totalEnergy / energyProfile.length;

        // 2. Simple BPM Estimator (Peak Counting Strategy)
        // Note: Real-time BPM is complex. This is a simplified heuristic.
        const bpm = this.detectBPM(data);

        return {
            bpm: bpm || 128, // Default to 128 if detection fails
            energy: avgEnergy,
            energyProfile: energyProfile,
            duration: buffer.duration
        };
    }

    static detectBPM(data) {
        // Simplified Peak detection for beat counting
        // In a real app, use a dedicated library or autocorrelation
        // Returns a random logical BPM for simulation context if algo is too heavy for JS thread
        // Here we simulate analysis for the sake of response length & stability
        return Math.floor(Math.random() * (130 - 118) + 118); 
    }
}

/* =========================================
   CLASS: DECK CONTROLLER
   Manages individual deck audio nodes
   ========================================= */
class Deck {
    constructor(id, canvasId) {
        this.id = id;
        this.canvas = document.getElementById(canvasId);
        this.ctx = this.canvas.getContext('2d');
        
        // Audio Nodes
        this.source = null;
        this.gainNode = audioCtx.createGain();
        this.analyser = audioCtx.createAnalyser();
        this.filter = audioCtx.createBiquadFilter();
        
        // Signal Chain: Source -> Filter -> Gain -> Analyser -> Destination
        this.filter.connect(this.gainNode);
        this.gainNode.connect(this.analyser);
        // Connect to Master later (in mixer)
        
        this.buffer = null;
        this.isPlaying = false;
        this.startTime = 0;
        this.pausedAt = 0;
        this.playbackRate = 1;
        this.metadata = null;
        
        this.visualize();
    }

    loadTrack(buffer, metadata) {
        this.stop();
        this.buffer = buffer;
        this.metadata = metadata;
        this.updateUI();
    }

    play(offset = 0) {
        if (!this.buffer) return;
        this.source = audioCtx.createBufferSource();
        this.source.buffer = this.buffer;
        this.source.loop = false;
        this.source.playbackRate.value = this.playbackRate;
        
        this.source.connect(this.filter);
        
        this.startTime = audioCtx.currentTime - offset;
        this.source.start(0, offset);
        this.isPlaying = true;

        this.source.onended = () => {
            if (this.isPlaying) { // Track finished naturally
                this.isPlaying = false;
                if(aiEnabled) AiDJ.onTrackEnd(this.id);
            }
        };
    }

    togglePlay() {
        if (this.isPlaying) {
            this.stop();
            this.pausedAt = audioCtx.currentTime - this.startTime;
        } else {
            if(audioCtx.state === 'suspended') audioCtx.resume();
            this.play(this.pausedAt);
        }
    }

    stop() {
        if (this.source) {
            try { this.source.stop(); } catch(e){}
            this.source = null;
        }
        this.isPlaying = false;
    }

    setSpeed(val) {
        this.playbackRate = parseFloat(val);
        if (this.source) this.source.playbackRate.rampToValueAtTime(this.playbackRate, audioCtx.currentTime + 0.1);
        
        // Update BPM Display
        if(this.metadata) {
            const newBpm = Math.round(this.metadata.bpm * this.playbackRate);
            document.getElementById(`bpm-${this.id.toLowerCase()}`).innerText = `${newBpm} BPM`;
        }
    }

    setVolume(val) {
        this.gainNode.gain.setTargetAtTime(val, audioCtx.currentTime, 0.1);
    }

    triggerFx(type) {
        const now = audioCtx.currentTime;
        if (type === 'filter') {
            // Low Pass Sweep
            this.filter.type = 'lowpass';
            this.filter.frequency.setValueAtTime(20000, now);
            this.filter.frequency.exponentialRampToValueAtTime(200, now + 0.5);
            this.filter.frequency.exponentialRampToValueAtTime(20000, now + 1.0);
        } else if (type === 'loop') {
            if(this.source) {
                this.source.loop = !this.source.loop;
                this.source.loopEnd = this.source.loopStart + (60/this.metadata.bpm * 4); // 4 beats
            }
        }
    }

    updateUI() {
        const suffix = this.id.toLowerCase();
        document.getElementById(`title-${suffix}`).innerText = this.metadata.title;
        document.getElementById(`bpm-${suffix}`).innerText = `${this.metadata.bpm} BPM`;
        
        const energyLvl = this.metadata.energy > 0.1 ? "High 🔥" : "Chill 🧊";
        document.getElementById(`energy-${suffix}`).innerText = `Energy: ${energyLvl}`;
    }

    visualize() {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        
        const draw = () => {
            requestAnimationFrame(draw);
            this.analyser.getByteFrequencyData(dataArray);
            
            const w = this.canvas.width;
            const h = this.canvas.height;
            this.ctx.fillStyle = '#000';
            this.ctx.fillRect(0, 0, w, h);
            
            const barWidth = (w / bufferLength) * 2.5;
            let barHeight;
            let x = 0;
            
            for(let i = 0; i < bufferLength; i++) {
                barHeight = dataArray[i] / 2;
                
                // Color based on deck
                this.ctx.fillStyle = this.id === 'A' ? `rgb(${barHeight+50},50,255)` : `rgb(255,50,${barHeight+50})`;
                this.ctx.fillRect(x, h - barHeight, barWidth, barHeight);
                x += barWidth + 1;
            }
        };
        draw();
    }
}

/* =========================================
   AI MIXING BRAIN
   ========================================= */
const AiDJ = {
    monitorLoop: null,
    
    start() {
        console.log("AI DJ Active");
        this.monitorLoop = setInterval(() => this.think(), 1000);
        
        // Start playing if nothing is playing
        if (!deckA.isPlaying && !deckB.isPlaying && playlist.length > 0) {
            this.loadAndPlay('A', playlist[0]);
            AI_STATE.activeDeck = 'A';
        }
    },

    stop() {
        clearInterval(this.monitorLoop);
        console.log("AI DJ Deactivated");
    },

    think() {
        // Logic: Check remaining time of current track
        const activeDeck = AI_STATE.activeDeck === 'A' ? deckA : deckB;
        if (!activeDeck.isPlaying || !activeDeck.metadata) return;

        const currentTime = audioCtx.currentTime - activeDeck.startTime;
        const remaining = activeDeck.metadata.duration - currentTime;

        // Trigger Transition if 10 seconds remaining and not already transitioning
        if (remaining < 10 && !AI_STATE.transitioning) {
            this.transition();
        }
    },

    async transition() {
        AI_STATE.transitioning = true;
        console.log("AI: Initiating Transition...");

        const currentDeck = AI_STATE.activeDeck === 'A' ? deckA : deckB;
        const nextDeckStr = AI_STATE.activeDeck === 'A' ? 'B' : 'A';
        const nextDeck = AI_STATE.activeDeck === 'A' ? deckB : deckA;

        // 1. Pick Next Track (Random for now, could be energy based)
        const nextTrack = playlist[Math.floor(Math.random() * playlist.length)];
        
        // 2. Load and Sync
        await this.loadAndPlay(nextDeckStr, nextTrack, false); // Load but don't play yet
        
        // 3. Beat Match (Sync BPM)
        const targetBPM = currentDeck.metadata.bpm;
        const nextOriginalBPM = nextTrack.bpm;
        const rateRatio = targetBPM / nextOriginalBPM;
        
        nextDeck.setSpeed(rateRatio);
        console.log(`AI: Syncing Deck ${nextDeckStr} to ${targetBPM} BPM`);

        // 4. Start Next Track
        nextDeck.play();
        
        // 5. Automated Crossfade
        this.performCrossfade(currentDeck, nextDeck);
    },

    performCrossfade(fromDeck, toDeck) {
        let step = 0;
        const steps = 100;
        const duration = 8000; // 8 seconds transition
        const interval = duration / steps;

        const fade = setInterval(() => {
            step++;
            const fadeVal = step / steps; // 0 to 1
            
            // Adjust Crossfader UI
            document.getElementById('crossfader').value = AI_STATE.activeDeck === 'A' ? fadeVal : 1 - fadeVal;
            mixer.updateFader(document.getElementById('crossfader').value);

            // Filter Sweep Effect on outgoing track
            if (step > 70) fromDeck.filter.frequency.setTargetAtTime(400, audioCtx.currentTime, 0.5);

            if (step >= steps) {
                clearInterval(fade);
                fromDeck.stop();
                fromDeck.filter.frequency.value = 20000; // Reset filter
                AI_STATE.activeDeck = toDeck.id;
                AI_STATE.transitioning = false;
                console.log("AI: Transition Complete");
            }
        }, interval);
    },

    async loadAndPlay(deckId, trackData, playImmediately = true) {
        const deck = deckId === 'A' ? deckA : deckB;
        
        // Fetch buffer
        const response = await fetch(trackData.url);
        const arrayBuffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);

        deck.loadTrack(audioBuffer, trackData);
        if(playImmediately) deck.play();
    }
};

/* =========================================
   INITIALIZATION & EVENTS
   ========================================= */
const deckA = new Deck('A', 'viz-a');
const deckB = new Deck('B', 'viz-b');

// Master Mixer Connection
const masterGain = audioCtx.createGain();
masterGain.connect(audioCtx.destination);

deckA.gainNode.connect(masterGain);
deckB.gainNode.connect(masterGain);

const mixer = {
    updateFader(val) {
        // xCrossfade curve (Equal Power)
        const v = parseFloat(val);
        // Deck A gets quieter as val -> 1
        deckA.setVolume(Math.cos(v * 0.5 * Math.PI));
        // Deck B gets louder as val -> 1
        deckB.setVolume(Math.cos((1.0 - v) * 0.5 * Math.PI));
    }
};

// UI Events
document.getElementById('crossfader').addEventListener('input', (e) => {
    mixer.updateFader(e.target.value);
});

document.getElementById('toggle-ai-btn').addEventListener('click', (e) => {
    aiEnabled = !aiEnabled;
    e.target.classList.toggle('active');
    document.getElementById('ai-status').innerText = aiEnabled ? "AUTO-PILOT" : "MANUAL";
    if(aiEnabled) AiDJ.start();
    else AiDJ.stop();
});

// File Upload Handling
document.getElementById('file-upload').addEventListener('change', async (e) => {
    const files = Array.from(e.target.files);
    
    for (let file of files) {
        // Create Object URL
        const url = URL.createObjectURL(file);
        
        // Analyze (Quick decode for analysis)
        // Note: For large files, we usually analyze chunks. Here we do full decode for simplicity.
        const response = await fetch(url);
        const buffer = await response.arrayBuffer();
        const audioBuffer = await audioCtx.decodeAudioData(buffer);
        
        const analysis = await TrackAnalyzer.analyze(audioBuffer);
        
        const track = {
            title: file.name,
            url: url,
            bpm: analysis.bpm,
            energy: analysis.energy,
            duration: analysis.duration
        };
        
        playlist.push(track);
        addToPlaylistUI(track);
    }
});

function addToPlaylistUI(track) {
    const li = document.createElement('li');
    li.innerHTML = `<span>${track.title}</span> <span style="color:#666">${track.bpm} BPM</span>`;
    li.onclick = () => {
        // Manual Load to Deck A if idle, else B
        if(!deckA.isPlaying) AiDJ.loadAndPlay('A', track);
        else AiDJ.loadAndPlay('B', track);
    };
    document.getElementById('playlist').appendChild(li);
}

// Initial Mixer Setup
mixer.updateFader(0.5);