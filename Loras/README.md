# Loras Folder

Place `.safetensors` LoRA files here.

Iris Studio scans this folder to:

- inspect safetensors metadata
- infer whether the file looks like a `fal.ai` BF16 or `ComfyUI / Kohya` LoRA
- detect the likely base model when metadata allows it
- expose only compatible LoRAs in the Studio UI

The current app catalogs and filters LoRAs here, but local generation still depends on native LoRA loading support in `iris.c`.
