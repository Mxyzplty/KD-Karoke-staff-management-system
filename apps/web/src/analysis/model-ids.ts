// SPDX-License-Identifier: AGPL-3.0-only
// The local model ids, kept apart from models.ts so the page can name them (availability.ts) without loading
// Transformers.js on the main thread; only the analysis worker loads the models.
export const MODEL_IDS = { whisper: 'onnx-community/whisper-small_timestamped', vision: 'onnx-community/Florence-2-base-ft', embedding: 'Xenova/all-MiniLM-L6-v2', sound: 'Xenova/ast-finetuned-audioset-10-10-0.4593', speaker: 'onnx-community/wespeaker-voxceleb-resnet34-LM', vad: 'onnx-community/pyannote-segmentation-3.0', aligner: 'onnx-community/wav2vec2-large-xlsr-english-ONNX', beats: 'CPJKU/beat_this', clip: 'Xenova/clip-vit-base-patch32', qwen3Asr: 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25' };
