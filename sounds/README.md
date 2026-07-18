# Sound assets

All gameplay audio is decoded into reusable Web Audio buffers at startup. Every
asset is a 44.1 kHz, 16-bit PCM WAV normalized toward -18 dBFS RMS with a strict
-1.5 dBFS peak ceiling. Files may be mono or stereo.

## Dynamic motor and driving loops

`EngineLoop.wav` contains a steady engine at one constant medium RPM. The engine
crossfades its seam and continuously controls pitch, load, filtering, boost, and
simulated gear shifts at runtime. Enemy vehicles use spatially attenuated instances
of the same loop.

`EngineStart-eshp1.wav` is a separate one-shot and plays once for every player spawn.

`GroundDriving-vcddirt.wav` supplies the rolling surface layer. It is quieter and
filtered on roads, louder off-road, and gains extra presence while drifting.

## Explosions

Explosion audio randomly selects one of the bundled variants:

- `Explosion1.wav`
- `Explosion2.wav`
- `Explosion3.wav`

Terrain and vehicle impacts select from their respective crash-sample pools.
