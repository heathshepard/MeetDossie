#!/usr/bin/env bash
# download-models.sh — fetches the ONNX/RNNoise model weights the video
# engine needs. Not committed to git (models/ is gitignored — these are
# 1-15MB binaries, no reason to bloat a public repo with them); run this
# once per machine instead.
set -euo pipefail
cd "$(dirname "$0")/../.."
mkdir -p models

echo "RobustVideoMatting mobilenetv3 (background separation)..."
curl -sL --max-time 60 -o models/rvm_mobilenetv3_fp32.onnx \
  https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/rvm_mobilenetv3_fp32.onnx

echo "Ultra-Light-Fast-Generic-Face-Detector RFB-320 (face-tracked auto-framing)..."
curl -sL --max-time 30 -o models/version-RFB-320.onnx \
  https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-RFB-320.onnx

echo "RNNoise 'somnolent-hogwash' model (audio cleanup, ffmpeg arnndn filter)..."
curl -sL --max-time 30 -o models/rnnoise-mp.rnnn \
  https://raw.githubusercontent.com/GregorR/rnnoise-models/master/somnolent-hogwash-2018-09-01/sh.rnnn

ls -la models/
echo "Done."
