# Models Folder

Place full model folders in this directory so Iris Studio can detect them automatically.

Each model should live in its own folder with the Hugging Face repository contents inside it, including:

- `model_index.json`
- `transformer/`
- `text_encoder/`
- `tokenizer/`
- `vae/`

Supported folder names:

- `flux-klein-4b-distilled/`
- `flux-klein-4b-base/`
- `flux-klein-9b-distilled/`
- `flux-klein-9b-base/`

If a model folder exists but one of those parts is missing, the Models page will show a warning and offer `Download Missing Files`.
