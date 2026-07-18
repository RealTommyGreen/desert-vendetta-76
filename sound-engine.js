(() => {
  "use strict";

  const DEFAULT_SAMPLES = {
    engineStart: "EngineStart-eshp1.wav",
    machineGun: "MachineGun-wmmgun.wav",
    rocket: "Rocket-wrhm.wav",
    wave: "FirstAndNewWave-cgrowl.wav",
    damageAlarm: "DamageAlarm-clockon.wav",
    turnLeft: "TurnLeft-tturn4.wav",
    turnRight: "TurnRight-tturn3.wav",
    driftLeft: "DriftLeft-tturn2.wav",
    driftRight: "DriftRight-tturn1.wav",
    groundDriving: "GroundDriving-vcddirt.wav",
    crashTerrainA: "CrashTerrain1-vvbo1.wav",
    crashTerrainB: "CrashTerrain2-vvcbb3.wav",
    crashVehicleA: "CrashVehicle1-vvcre2.wav",
    crashVehicleB: "CrashVehicle2.wav",
    hitLight: "Hit3-wclick.wav",
    hitMetalA: "Hit1-wmgr1.wav",
    hitMetalB: "Hit2-wmgr2.wav",
    hitHeavyA: "Hit4.wav",
    hitHeavyB: "Hit5.wav",
    hitHeavyC: "Hit6.wav",
  };

  // Long-form layers and explosion variants remain separately configurable;
  // ignition is always a distinct one-shot.
  const OPTIONAL_SAMPLES = {
    engineLoop: "EngineLoop.wav",
    explosionA: "Explosion1.wav",
    explosionB: "Explosion2.wav",
    explosionC: "Explosion3.wav",
  };

  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

  class SampleSoundEngine {
    constructor({
      baseUrl = "sounds/",
      samples = {},
      maxVoices = 56,
      masterVolume = 0.72,
    } = {}) {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) throw new Error("Web Audio is not supported by this WebView");

      this.ctx = new AudioCtx({ latencyHint: "interactive" });
      this.maxVoices = maxVoices;
      this.buffers = new Map();
      this.voices = new Set();
      this.listenerPosition = { x: 0, y: 0, z: 0 };
      this.listenerRight = { x: 1, y: 0, z: 0 };
      this.engineWanted = false;
      this.engineNodes = null;
      this.groundNodes = null;
      this.vehicleEngineVoices = new WeakMap();
      this.steeringVoices = new WeakMap();
      this.alarmVoice = null;
      this.lastAlarmAt = -Infinity;

      this.master = this.ctx.createGain();
      this.master.gain.value = masterVolume;
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -12;
      this.compressor.knee.value = 16;
      this.compressor.ratio.value = 5;
      this.compressor.attack.value = 0.003;
      this.compressor.release.value = 0.18;
      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);

      this.sfxBus = this.ctx.createGain();
      this.engineBus = this.ctx.createGain();
      this.uiBus = this.ctx.createGain();
      this.sfxBus.gain.value = 0.9;
      this.engineBus.gain.value = 0.78;
      this.uiBus.gain.value = 0.72;
      this.sfxBus.connect(this.master);
      this.engineBus.connect(this.master);
      this.uiBus.connect(this.master);

      const required = Object.entries({ ...DEFAULT_SAMPLES, ...samples })
        .map(([name, path]) => ({ name, path, optional: false }));
      const optional = Object.entries(OPTIONAL_SAMPLES)
        .filter(([name]) => !Object.prototype.hasOwnProperty.call(samples, name))
        .map(([name, path]) => ({ name, path, optional: true }));
      const entries = [...required, ...optional];
      this.ready = Promise.allSettled(entries.map(async ({ name, path }) => {
        const url = new URL(path, new URL(baseUrl, document.baseURI));
        const buffer = await this.#loadAudioBuffer(url);
        this.buffers.set(name, buffer);
      })).then(results => {
        const failures = results.filter((result, index) =>
          result.status === "rejected" && !entries[index].optional
        );
        if (failures.length) {
          console.warn("Some sound samples could not be loaded", failures);
        }
        if (this.engineWanted) this.#startEngineNodes();
        return failures.length === 0;
      });
    }

    async resume() {
      if (this.ctx.state !== "running") await this.ctx.resume();
      return this.ready;
    }

    suspend() {
      if (this.ctx.state === "running") this.ctx.suspend();
    }

    play(name, {
      volume = 1,
      rate = 1,
      detune = 0,
      position = null,
      range = 120,
      rolloff = 1.35,
      priority = 1,
      bus = "sfx",
      loop = false,
      delay = 0,
      offset = 0,
      duration = null,
      attack = 0,
      release = 0.025,
    } = {}) {
      const buffer = this.buffers.get(name);
      if (!buffer || this.ctx.state === "closed") return null;
      if (!this.#makeVoiceRoom(priority)) return null;

      const source = this.ctx.createBufferSource();
      const envelope = this.ctx.createGain();
      const gain = this.ctx.createGain();
      const panner = this.ctx.createStereoPanner ? this.ctx.createStereoPanner() : null;
      source.buffer = buffer;
      source.playbackRate.value = rate;
      source.detune.value = detune;
      source.loop = loop;
      envelope.gain.value = 1;
      gain.gain.value = volume;

      source.connect(envelope);
      envelope.connect(gain);
      if (panner) {
        gain.connect(panner);
        panner.connect(this.#bus(bus));
      } else {
        gain.connect(this.#bus(bus));
      }

      const voice = {
        source, envelope, gain, panner, position, range, rolloff, priority,
        baseVolume: volume, stopped: false,
      };
      this.voices.add(voice);
      this.#updateVoiceSpatial(voice, true);
      source.onended = () => {
        voice.stopped = true;
        this.voices.delete(voice);
        if (this.alarmVoice === voice) this.alarmVoice = null;
        source.disconnect();
        envelope.disconnect();
        gain.disconnect();
        if (panner) panner.disconnect();
      };
      const startAt = this.ctx.currentTime + delay;
      if (duration && !loop) {
        const playbackDuration = duration / Math.max(0.01, rate);
        const stopAt = startAt + playbackDuration;
        const fadeIn = Math.min(Math.max(0, attack), playbackDuration * .35);
        const fadeOut = Math.min(Math.max(0.004, release), playbackDuration * .45);
        if (fadeIn > 0) {
          envelope.gain.setValueAtTime(0.0001, startAt);
          envelope.gain.linearRampToValueAtTime(1, startAt + fadeIn);
        }
        envelope.gain.setValueAtTime(1, Math.max(startAt + fadeIn, stopAt - fadeOut));
        envelope.gain.linearRampToValueAtTime(0.0001, stopAt);
        source.start(startAt, Math.min(offset, Math.max(0, buffer.duration - 0.01)), duration);
      } else {
        if (attack > 0) {
          envelope.gain.setValueAtTime(0.0001, startAt);
          envelope.gain.linearRampToValueAtTime(1, startAt + attack);
        }
        source.start(startAt, Math.min(offset, Math.max(0, buffer.duration - 0.01)));
      }
      return voice;
    }

    playAny(names, options = {}) {
      const available = names.filter(name => this.buffers.has(name));
      if (!available.length) return null;
      return this.play(available[Math.floor(Math.random() * available.length)], options);
    }

    playWhenReady(name, options = {}) {
      if (this.buffers.has(name)) return Promise.resolve(this.play(name, options));
      return this.ready.then(() => this.play(name, options));
    }

    stopVoice(voice, fadeSeconds = 0.03) {
      if (!voice || voice.stopped) return;
      const now = this.ctx.currentTime;
      voice.envelope.gain.cancelScheduledValues(now);
      voice.envelope.gain.setValueAtTime(Math.max(0.0001, voice.envelope.gain.value), now);
      voice.envelope.gain.exponentialRampToValueAtTime(0.0001, now + fadeSeconds);
      try {
        voice.source.stop(now + fadeSeconds + 0.01);
      } catch (_) {
        // A voice may already have naturally ended.
      }
    }

    updateListener(position, right) {
      this.listenerPosition.x = position.x;
      this.listenerPosition.y = position.y;
      this.listenerPosition.z = position.z;
      this.listenerRight.x = right.x;
      this.listenerRight.y = right.y;
      this.listenerRight.z = right.z;
      for (const voice of this.voices) this.#updateVoiceSpatial(voice, false);
    }

    startEngine() {
      this.engineWanted = true;
      if (this.buffers.has("engineLoop")) this.#startEngineNodes();
    }

    playEngineStart(position = null) {
      const play = () => this.play("engineStart", {
        volume: 0.62,
        position,
        range: 80,
        priority: 4,
        bus: "engine",
      });
      if (this.buffers.has("engineStart")) return play();
      this.ready.then(play);
      return null;
    }

    stopEngine(fadeSeconds = 0.2) {
      this.engineWanted = false;
      this.stopGround(fadeSeconds);
      if (!this.engineNodes) return;
      const now = this.ctx.currentTime;
      for (const layer of this.engineNodes.layers) {
        layer.gain.gain.cancelScheduledValues(now);
        layer.gain.gain.setTargetAtTime(0.0001, now, fadeSeconds / 3);
        try { layer.source.stop(now + fadeSeconds); } catch (_) {}
      }
      this.engineNodes = null;
    }

    updateEngine(speed, throttle, boosting, alive = true) {
      if (!alive) {
        this.stopEngine();
        return;
      }
      if (!this.engineNodes) {
        if (this.engineWanted) this.#startEngineNodes();
        return;
      }

      const now = this.ctx.currentTime;
      const absSpeed = Math.max(0, speed);
      const gearBands = [0, 11, 23, 37, 53, 73];
      let gear = gearBands.length - 2;
      for (let i = 0; i < gearBands.length - 1; i++) {
        if (absSpeed < gearBands[i + 1]) { gear = i; break; }
      }
      const gearProgress = clamp(
        (absSpeed - gearBands[gear]) / (gearBands[gear + 1] - gearBands[gear]),
        0, 1
      );
      const load = clamp(Math.abs(throttle), 0, 1);
      const rpm = clamp(0.2 + gearProgress * 0.68 + load * 0.13 + (boosting ? 0.14 : 0), 0.18, 1.08);
      const rate = 0.66 + rpm * 1.18;
      const baseVolume = 0.19 + load * 0.13 + clamp(absSpeed / 72, 0, 1) * 0.08;

      const [body, texture] = this.engineNodes.layers;
      body.source.playbackRate.setTargetAtTime(rate, now, 0.055);
      texture.source.playbackRate.setTargetAtTime(rate * 1.018, now, 0.065);
      body.filter.frequency.setTargetAtTime(520 + rpm * 1450 + load * 500, now, 0.08);
      texture.filter.frequency.setTargetAtTime(900 + rpm * 3100, now, 0.09);
      body.gain.gain.setTargetAtTime(baseVolume, now, 0.07);
      texture.gain.gain.setTargetAtTime(baseVolume * (0.23 + load * 0.18), now, 0.08);
    }

    updateGround(speed, onRoad, drifting, alive = true) {
      if (!alive) {
        this.stopGround();
        return;
      }
      if (!this.groundNodes) {
        if (this.engineWanted && this.buffers.has("groundDriving")) this.#startGroundNodes();
        if (!this.groundNodes) return;
      }

      const now = this.ctx.currentTime;
      const speedMix = clamp((speed - 2) / 48, 0, 1);
      const targetVolume = speedMix * (onRoad ? 0.075 : 0.22)
        + (drifting ? speedMix * 0.10 : 0);
      this.groundNodes.source.playbackRate.setTargetAtTime(0.72 + speedMix * 0.72, now, 0.08);
      this.groundNodes.filter.frequency.setTargetAtTime(onRoad ? 1050 : 2700, now, 0.12);
      this.groundNodes.gain.gain.setTargetAtTime(Math.max(0.0001, targetVolume), now, 0.09);
    }

    stopGround(fadeSeconds = 0.16) {
      if (!this.groundNodes) return;
      const nodes = this.groundNodes;
      this.groundNodes = null;
      const now = this.ctx.currentTime;
      nodes.gain.gain.cancelScheduledValues(now);
      nodes.gain.gain.setTargetAtTime(0.0001, now, fadeSeconds / 3);
      try { nodes.source.stop(now + fadeSeconds); } catch (_) {}
    }

    updateVehicleEngine(vehicle, speed, throttle, position, alive = true) {
      if (!alive || !this.engineWanted) {
        this.stopVehicleEngine(vehicle);
        return;
      }
      const speedMix = clamp(speed / 65, 0, 1);
      const load = clamp(Math.abs(throttle), 0, 1);
      const rate = 0.70 + speedMix * 0.88 + load * 0.12;
      const volume = 0.16 + speedMix * 0.13 + load * 0.08;
      let voice = this.vehicleEngineVoices.get(vehicle);

      if (!voice || voice.stopped) {
        voice = this.play("engineLoopSeamless", {
          volume,
          rate,
          position,
          range: 190,
          rolloff: 1,
          priority: 1,
          bus: "engine",
          loop: true,
          attack: 0.09,
          offset: Math.random() * 0.35,
        });
        if (voice) this.vehicleEngineVoices.set(vehicle, voice);
        return;
      }

      const now = this.ctx.currentTime;
      voice.baseVolume = volume;
      voice.source.playbackRate.setTargetAtTime(rate, now, 0.09);
      this.#updateVoiceSpatial(voice, false);
    }

    stopVehicleEngine(vehicle, fadeSeconds = 0.12) {
      const voice = this.vehicleEngineVoices.get(vehicle);
      if (voice && !voice.stopped) this.stopVoice(voice, fadeSeconds);
      this.vehicleEngineVoices.delete(vehicle);
    }

    updateSteering(vehicle, direction, drifting, braking, speed, position = null, alive = true) {
      const moving = alive && (Math.abs(direction) > 0 || braking) && speed >= 5;
      if (!moving) {
        this.stopSteering(vehicle);
        return;
      }

      // Straight-line braking deliberately uses the left turn sample. With
      // steering input, retain the matching side and drift variant.
      const side = direction < 0 ? "Right" : "Left";
      const state = `${drifting ? "drift" : "turn"}${side}`;
      const speedMix = clamp((speed - 5) / 35, 0, 1);
      const remote = position !== null;
      const volume = (drifting ? 0.34 + speedMix * 0.16 : 0.20 + speedMix * 0.12)
        * (remote ? 1.12 : 1);
      const current = this.steeringVoices.get(vehicle);

      if (current?.state === state && current.voice && !current.voice.stopped) {
        current.voice.baseVolume = volume;
        this.#updateVoiceSpatial(current.voice, false);
        if (!position) current.voice.gain.gain.setTargetAtTime(volume, this.ctx.currentTime, 0.045);
        return;
      }

      if (current?.voice && !current.voice.stopped) {
        this.stopVoice(current.voice, 0.055);
      }
      const buffer = this.buffers.get(state);
      if (!buffer) {
        this.steeringVoices.delete(vehicle);
        return;
      }
      const voice = this.play(state, {
        volume,
        rate: drifting ? 0.98 : 1,
        duration: Math.max(0.05, buffer.duration - 0.008),
        attack: 0.025,
        release: 0.075,
        position,
        range: remote ? 155 : 120,
        rolloff: remote ? 0.9 : 1.35,
        priority: remote ? 1 : 2,
      });
      this.steeringVoices.set(vehicle, { state, voice });
    }

    stopSteering(vehicle, fadeSeconds = 0.07) {
      const current = this.steeringVoices.get(vehicle);
      if (current?.voice && !current.voice.stopped) {
        this.stopVoice(current.voice, fadeSeconds);
      }
      this.steeringVoices.delete(vehicle);
    }

    setDamageAlarm(active) {
      const now = this.ctx.currentTime;
      if (!active) {
        if (this.alarmVoice) this.stopVoice(this.alarmVoice, 0.08);
        return;
      }
      if (this.alarmVoice || now - this.lastAlarmAt < 1.35) return;
      this.lastAlarmAt = now;
      this.alarmVoice = this.play("damageAlarm", {
        volume: 0.38, priority: 3, bus: "ui",
      });
    }

    #startEngineNodes() {
      if (this.engineNodes || !this.engineWanted) return;
      // engineLoop is intentionally separate from the one-shot ignition sample.
      // It can be supplied later through the samples option without changing gameplay code.
      const sourceBuffer = this.buffers.get("engineLoop");
      if (!sourceBuffer) return;

      const loopBuffer = this.#makeSeamlessLoop(sourceBuffer);
      this.buffers.set("engineLoopSeamless", loopBuffer);
      const startAt = this.ctx.currentTime;
      const layers = [
        this.#createEngineLayer(loopBuffer, "lowpass", 900, 0.0001, startAt, 0),
        this.#createEngineLayer(loopBuffer, "bandpass", 1700, 0.0001, startAt, 0.071),
      ];
      for (const layer of layers) {
        layer.source.onended = () => {
          layer.source.disconnect();
          layer.filter.disconnect();
          layer.gain.disconnect();
        };
      }
      this.engineNodes = { layers };
    }

    #startGroundNodes() {
      const sourceBuffer = this.buffers.get("groundDriving");
      if (!sourceBuffer || this.groundNodes) return;
      const buffer = this.#makeSeamlessLoop(sourceBuffer);
      const source = this.ctx.createBufferSource();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = "lowpass";
      filter.frequency.value = 1200;
      filter.Q.value = 0.45;
      gain.gain.value = 0.0001;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.engineBus);
      source.onended = () => {
        source.disconnect();
        filter.disconnect();
        gain.disconnect();
      };
      source.start(this.ctx.currentTime);
      this.groundNodes = { source, filter, gain };
    }

    async #loadAudioBuffer(url) {
      let data;
      try {
        const response = await fetch(url);
        if (!response.ok && response.status !== 0) {
          throw new Error(`${response.status} ${url}`);
        }
        data = await response.arrayBuffer();
      } catch (fetchError) {
        data = await new Promise((resolve, reject) => {
          const request = new XMLHttpRequest();
          request.open("GET", url.href, true);
          request.responseType = "arraybuffer";
          request.onload = () => {
            if ((request.status >= 200 && request.status < 300) || request.status === 0) {
              resolve(request.response);
            } else {
              reject(new Error(`${request.status} ${url}`));
            }
          };
          request.onerror = () => reject(fetchError);
          request.send();
        });
      }
      return this.ctx.decodeAudioData(data);
    }

    #makeSeamlessLoop(buffer) {
      const startSeconds = Math.min(0.04, buffer.duration * 0.02);
      const endSeconds = Math.max(startSeconds + 0.28, buffer.duration - 0.04);
      const start = Math.floor(startSeconds * buffer.sampleRate);
      const end = Math.min(buffer.length, Math.floor(endSeconds * buffer.sampleRate));
      const sourceLength = end - start;
      const fade = Math.min(Math.floor(buffer.sampleRate * 0.075), Math.floor(sourceLength * 0.18));
      const length = sourceLength - fade;
      const result = this.ctx.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);

      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const input = buffer.getChannelData(channel);
        const output = result.getChannelData(channel);
        for (let i = 0; i < length; i++) output[i] = input[start + i];
        for (let i = 0; i < fade; i++) {
          const mix = i / Math.max(1, fade - 1);
          const at = length - fade + i;
          output[at] = input[start + at] * (1 - mix) + input[start + i] * mix;
        }
      }
      return result;
    }

    #createEngineLayer(buffer, filterType, frequency, volume, startAt, offset) {
      const source = this.ctx.createBufferSource();
      const filter = this.ctx.createBiquadFilter();
      const gain = this.ctx.createGain();
      source.buffer = buffer;
      source.loop = true;
      filter.type = filterType;
      filter.frequency.value = frequency;
      filter.Q.value = filterType === "bandpass" ? 0.7 : 0.35;
      gain.gain.value = volume;
      source.connect(filter);
      filter.connect(gain);
      gain.connect(this.engineBus);
      source.start(startAt, Math.min(offset, Math.max(0, buffer.duration - 0.01)));
      return { source, filter, gain };
    }

    #updateVoiceSpatial(voice, immediate) {
      if (!voice.position) return;
      const dx = voice.position.x - this.listenerPosition.x;
      const dy = voice.position.y - this.listenerPosition.y;
      const dz = voice.position.z - this.listenerPosition.z;
      const distance = Math.hypot(dx, dy, dz);
      const normalizedDistance = distance / Math.max(1, voice.range);
      const attenuation = 1 / (1 + voice.rolloff * normalizedDistance * normalizedDistance * 5);
      const horizontalLength = Math.max(0.001, Math.hypot(dx, dz));
      const pan = clamp(
        (dx * this.listenerRight.x + dz * this.listenerRight.z) / horizontalLength,
        -1, 1
      );
      const now = this.ctx.currentTime;
      if (immediate) {
        voice.gain.gain.value = voice.baseVolume * attenuation;
        if (voice.panner) voice.panner.pan.value = pan;
      } else {
        voice.gain.gain.setTargetAtTime(voice.baseVolume * attenuation, now, 0.025);
        if (voice.panner) voice.panner.pan.setTargetAtTime(pan, now, 0.025);
      }
    }

    #makeVoiceRoom(priority) {
      if (this.voices.size < this.maxVoices) return true;
      let candidate = null;
      for (const voice of this.voices) {
        if (voice.priority > priority) continue;
        if (!candidate || voice.priority < candidate.priority) candidate = voice;
      }
      if (!candidate) return false;
      this.voices.delete(candidate);
      this.stopVoice(candidate, 0.012);
      return true;
    }

    #bus(name) {
      if (name === "engine") return this.engineBus;
      if (name === "ui") return this.uiBus;
      return this.sfxBus;
    }
  }

  window.SampleSoundEngine = SampleSoundEngine;
})();
