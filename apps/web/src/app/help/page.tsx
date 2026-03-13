'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Bot, FolderOpen, Images, Keyboard, Library, Lightbulb, Send, User, WandSparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';

interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

const KNOWLEDGE_BASE: Array<{ keywords: string[]; answer: string }> = [
  {
    keywords: ['start', 'begin', 'first', 'get started', 'how to use', 'new', 'setup'],
    answer: 'To get started: 1) Go to the Models page and download at least one model. 2) Switch to the Studio page. 3) Type a description in the prompt box. 4) Press Cmd+Enter or click Generate. Your image will appear in the center panel!',
  },
  {
    keywords: ['model', 'download', 'install', 'which model', 'choose model', '4b', '9b'],
    answer: 'Iris Studio supports four FLUX Klein models. The 4B Distilled is fastest and great for experimentation (needs 16 GB RAM minimum). The 9B Distilled offers better quality (needs 24 GB RAM minimum). Base variants give more creative range but take longer. Go to the Models page to download one — you need at least one installed model before generating.',
  },
  {
    keywords: ['lora', 'style', 'adapter', 'add-on', 'custom'],
    answer: 'LoRAs are small style add-ons that customize how your model generates images. Upload .safetensors files on the Loras page. Compatible LoRAs will appear in a dropdown on the Studio page. You can adjust their strength from 0.0 (no effect) to 2.0 (maximum). Only one LoRA can be active at a time.',
  },
  {
    keywords: ['mode', 'text', 'image', 'multi', 'reference', 'img2img'],
    answer: 'There are three modes: Text mode creates images from a prompt only. Image mode lets you upload one reference image and describe how to modify it. Multi mode accepts two or more reference images to blend elements together. Switch modes using the buttons at the top of the left panel.',
  },
  {
    keywords: ['seed', 'reproducible', 'same image', 'identical', 'repeat'],
    answer: 'A seed is a number that controls the randomness of generation. The same prompt + seed + size always produces the same image. Leave the seed field empty for random results, or enter a specific number to reproduce a previous result. You can find the seed of any past generation in the history panel details.',
  },
  {
    keywords: ['size', 'dimension', 'resolution', 'width', 'height', 'multiple', '16', '1792'],
    answer: 'Image dimensions must be multiples of 16, with a maximum of 1792 on either side. In Text mode, you can pick from presets or enter custom values. In Image/Multi mode, the output size is based on your reference image with an adjustable scale slider.',
  },
  {
    keywords: ['benchmark', 'speed', 'performance', 'eta', 'time estimate', 'how long'],
    answer: 'Run a benchmark from the Models page to measure your Mac\'s generation speed. Benchmarks are per-model and test multiple sizes. After benchmarking, the Studio will show accurate time estimates for your generations. The ETA improves further as you generate more images.',
  },
  {
    keywords: ['fail', 'error', 'broken', 'not working', 'crash', 'problem'],
    answer: 'Common fixes: 1) Make sure you have a model installed (Models page). 2) Check that dimensions are multiples of 16 and under 1792. 3) In Image/Multi mode, ensure you uploaded the required references. 4) If generation keeps failing, try a smaller size like 512×512 first. 5) Check that iris.c was built with "make mps" in vendor/iris.c.',
  },
  {
    keywords: ['history', 'past', 'previous', 'delete', 'download', 'export'],
    answer: 'The right panel shows your generation history. Click any image to view it in the center. Use "To Editor" to load its settings back into the controls. Click "1024" to rerun at higher resolution. Select multiple images with checkboxes for bulk download or delete. Use left/right arrow keys to navigate quickly.',
  },
  {
    keywords: ['prompt', 'write', 'describe', 'tip', 'better results', 'quality'],
    answer: 'Write descriptive prompts: "a golden sunset over a mountain lake, oil painting style" works better than "make a sunset." Be specific about style, lighting, composition, and subject. Use the shuffle button for random prompt ideas. You can also upload a .txt file with one prompt per line for batch generation.',
  },
  {
    keywords: ['memory', 'ram', 'unified', 'minimum', 'recommended', 'hardware', 'mac', 'apple silicon'],
    answer: 'Iris Studio runs on Apple Silicon Macs (M1/M2/M3/M4). Minimum: 16 GB unified memory for 4B models. Recommended: 24–36 GB for comfortable 9B usage. Best: 48 GB+ for the largest models and sustained sessions. The Models page shows specific memory requirements for each model.',
  },
  {
    keywords: ['cancel', 'stop', 'pause', 'restart', 'resume'],
    answer: 'During generation, click Stop in the history panel to cancel. Cancelled jobs show a Restart button to retry with the same settings, or use "To Editor" to adjust before regenerating. For model downloads, Pause keeps files so you can resume later; Stop deletes partial files permanently.',
  },
  {
    keywords: ['keyboard', 'shortcut', 'hotkey'],
    answer: 'Cmd+Enter generates an image from the Studio. Left/Right arrow keys navigate through your history. These work when the prompt box is not focused.',
  },
  {
    keywords: ['iteration', 'batch', 'multiple', 'queue', 'many'],
    answer: 'Open Advanced Settings in the left panel and set the Iterations field to generate multiple images. When iterations is 2 or more, you can choose "Same seed" (identical results) or "Varied seeds" (different variations). You can also upload a .txt file with multiple prompts for batch generation.',
  },
  {
    keywords: ['advanced', 'steps', 'guidance', 'cfg'],
    answer: 'Advanced Settings lets you control Steps (more = higher quality but slower), Guidance (how closely the model follows your prompt), and Iterations. Distilled models default to 4 steps with guidance 1.0. Base models use 50 steps with CFG guidance. Leave these at defaults unless you want to experiment.',
  },
];

function findBestAnswer(question: string): string {
  const lower = question.toLowerCase();
  const words = lower.split(/\s+/);

  let bestScore = 0;
  let bestAnswer = '';

  for (const entry of KNOWLEDGE_BASE) {
    let score = 0;
    for (const keyword of entry.keywords) {
      if (lower.includes(keyword)) {
        score += keyword.split(/\s+/).length * 2;
      } else {
        for (const word of words) {
          if (word.length >= 3 && keyword.includes(word)) {
            score += 1;
          }
        }
      }
    }
    if (score > bestScore) {
      bestScore = score;
      bestAnswer = entry.answer;
    }
  }

  if (bestScore < 2) {
    return 'I\'m not sure about that specific question. Try asking about models, LoRAs, generation modes, seeds, image sizes, benchmarks, prompts, or troubleshooting. You can also check the sections above for detailed guides.';
  }

  return bestAnswer;
}

export default function HelpPage() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const scrollRef = useRef<HTMLDivElement>(null);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    if (!trimmed) return;

    const userMsg: ChatMessage = { role: 'user', text: trimmed };
    const answer = findBestAnswer(trimmed);
    const assistantMsg: ChatMessage = { role: 'assistant', text: answer };

    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setInput('');
  }, [input]);

  useEffect(() => {
    if (messages.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;
    const frame = requestAnimationFrame(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    });
    return () => cancelAnimationFrame(frame);
  }, [messages.length]);

  return (
    <main className="mx-auto flex h-full w-full max-w-[1600px] flex-col gap-6 overflow-y-auto px-4 py-6">
      <section className="rounded-2xl border border-border bg-card/80 p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="space-y-2">
            <p className="text-xs uppercase tracking-[0.2em] text-muted-foreground">Help</p>
            <h1 className="text-2xl font-semibold text-foreground">How to use Iris Studio</h1>
            <p className="max-w-3xl text-sm text-muted-foreground">
              Everything you need to know about generating images, using references, and getting the most out of Iris Studio.
            </p>
          </div>
          <Link href="/" className="text-sm text-primary hover:text-primary/80">
            Open Studio
          </Link>
        </div>
      </section>

      <section className="grid gap-4 xl:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <WandSparkles className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Your first image</h2>
            </div>
            <ol className="mt-4 list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>Make sure you have at least one model installed from the <Link href="/models" className="text-primary hover:text-primary/80">Models</Link> page.</li>
              <li>Go to the <Link href="/" className="text-primary hover:text-primary/80">Studio</Link> page.</li>
              <li>Type a description of the image you want to create in the prompt box.</li>
              <li>Click <strong className="text-foreground">Generate</strong> or press <kbd className="rounded bg-secondary px-1.5 py-0.5 text-xs">Cmd+Enter</kbd>.</li>
              <li>Your image will appear in the center panel and be saved to your history on the right.</li>
            </ol>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Images className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Generation modes</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Switch between modes using the buttons at the top of the left panel.
            </p>
            <div className="mt-4 space-y-4 text-sm text-muted-foreground">
              <div className="rounded-xl border border-border/70 bg-background/70 p-4">
                <p className="font-medium text-foreground">Text</p>
                <p className="mt-2">Create images purely from a text description. Best for exploring new ideas quickly.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/70 p-4">
                <p className="font-medium text-foreground">Image</p>
                <p className="mt-2">Upload one reference image and describe what you want the result to look like. Great for restyling or repainting an existing image.</p>
              </div>
              <div className="rounded-xl border border-border/70 bg-background/70 p-4">
                <p className="font-medium text-foreground">Multi</p>
                <p className="mt-2">Upload two or more reference images to blend styles, subjects, or compositions.</p>
              </div>
            </div>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <FolderOpen className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Models and LoRAs</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              <strong className="text-foreground">Models</strong> are the base AI that generates your images.
              Go to the <Link href="/models" className="text-primary hover:text-primary/80">Models</Link> page to download one. Smaller models (4B) are faster, larger ones (9B) produce better quality.
            </p>
            <p className="mt-3 text-sm text-muted-foreground">
              <strong className="text-foreground">LoRAs</strong> are small add-ons that customize the model&apos;s style or subject matter.
              Visit the <Link href="/loras" className="text-primary hover:text-primary/80">Loras</Link> page to upload and manage them.
            </p>
          </section>

          {/* AI Assistant */}
          <section className="rounded-2xl border border-primary/20 bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Bot className="h-4 w-4 text-primary" />
              <h2 className="text-lg font-semibold">Ask a question</h2>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Can&apos;t find what you need above? Ask anything about using Iris Studio.
            </p>

            {messages.length === 0 && (
              <div className="mt-3 flex flex-wrap gap-1.5">
                {[
                  'How do I get started?',
                  'Which model should I use?',
                  'What is a LoRA?',
                  'How do seeds work?',
                  'Generation failed',
                  'How much RAM do I need?',
                ].map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => { setInput(q); }}
                    className="rounded-full border border-border px-3 py-1 text-xs text-muted-foreground transition-colors hover:border-primary/40 hover:bg-primary/10 hover:text-foreground"
                  >
                    {q}
                  </button>
                ))}
              </div>
            )}

            <div
              ref={scrollRef}
              className="mt-4 max-h-80 min-h-[6rem] space-y-3 overflow-y-auto rounded-xl border border-border/70 bg-background/70 p-4"
            >
              {messages.map((msg, i) => (
                <div key={i} className={`flex gap-2.5 ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  {msg.role === 'assistant' && (
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/10">
                      <Bot className="h-3.5 w-3.5 text-primary" />
                    </div>
                  )}
                  <div
                    className={`max-w-[85%] rounded-xl px-3 py-2 text-sm ${
                      msg.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-secondary text-foreground'
                    }`}
                  >
                    {msg.text}
                  </div>
                  {msg.role === 'user' && (
                    <div className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary">
                      <User className="h-3.5 w-3.5 text-muted-foreground" />
                    </div>
                  )}
                </div>
              ))}
            </div>

            <div className="mt-3 flex gap-2">
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="Ask about models, LoRAs, prompts, troubleshooting..."
                className="flex-1 rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary"
              />
              <Button
                type="button"
                size="sm"
                onClick={handleSend}
                disabled={!input.trim()}
              >
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </section>
        </div>

        <aside className="space-y-4">
          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Library className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Studio layout</h2>
            </div>
            <ul className="mt-4 space-y-3 text-sm text-muted-foreground">
              <li><strong className="text-foreground">Left panel</strong> &mdash; Your controls: mode, model, prompt, image size, LoRA, and advanced settings.</li>
              <li><strong className="text-foreground">Center</strong> &mdash; Shows the image being generated or the last completed result.</li>
              <li><strong className="text-foreground">Right panel</strong> &mdash; Your history. Click any past image to view it, send it back to the editor, or rerun it at a higher resolution.</li>
            </ul>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Keyboard className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li><kbd className="rounded bg-secondary px-1.5 py-0.5 text-xs">Cmd+Enter</kbd> &mdash; Generate image</li>
              <li><kbd className="rounded bg-secondary px-1.5 py-0.5 text-xs">Left/Right arrows</kbd> &mdash; Navigate through history</li>
            </ul>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <div className="flex items-center gap-2 text-foreground">
              <Lightbulb className="h-4 w-4" />
              <h2 className="text-lg font-semibold">Tips</h2>
            </div>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li>Use the shuffle button next to the prompt box for random prompt ideas.</li>
              <li>Write descriptive prompts (&quot;a golden sunset over a mountain lake&quot;) rather than commands (&quot;make a sunset&quot;).</li>
              <li>Found a result you like? Click &quot;1024&quot; in the history panel to rerun it at higher resolution.</li>
              <li>Click &quot;To Editor&quot; on any history item to load its exact settings back into the controls.</li>
              <li>Use a specific seed number to get reproducible results.</li>
              <li>If a LoRA effect is too strong or subtle, adjust its strength slider before generating.</li>
            </ul>
          </section>

          <section className="rounded-2xl border border-border bg-card/80 p-5">
            <h2 className="text-lg font-semibold text-foreground">Troubleshooting</h2>
            <ul className="mt-4 space-y-2 text-sm text-muted-foreground">
              <li><strong className="text-foreground">No models in Studio?</strong> Install one from the <Link href="/models" className="text-primary hover:text-primary/80">Models</Link> page first.</li>
              <li><strong className="text-foreground">LoRA not showing up?</strong> Check the <Link href="/loras" className="text-primary hover:text-primary/80">Loras</Link> page to see if it&apos;s compatible with your selected model.</li>
              <li><strong className="text-foreground">Generation failed?</strong> Make sure image dimensions are multiples of 16 and neither side exceeds 1792.</li>
              <li><strong className="text-foreground">Image/Multi mode disabled?</strong> You need to upload the required number of reference images first.</li>
            </ul>
          </section>
        </aside>
      </section>
    </main>
  );
}
