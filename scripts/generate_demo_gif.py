from __future__ import annotations

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import textwrap


ROOT = Path(__file__).resolve().parents[1]
DOCS_DIR = ROOT / "docs"
OUTPUT = DOCS_DIR / "demo-cli.gif"

WIDTH = 1200
HEIGHT = 720
PADDING = 36
LINE_HEIGHT = 28
FONT_SIZE = 22
TITLE_SIZE = 26
BG = "#0f1720"
PANEL = "#111827"
PANEL_BORDER = "#263244"
TEXT = "#d7e3f4"
MUTED = "#8ea3bc"
ACCENT = "#7dd3fc"
SUCCESS = "#86efac"
WARN = "#fcd34d"


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    candidates = [
        Path(r"C:\Windows\Fonts\consola.ttf"),
        Path(r"C:\Windows\Fonts\consolab.ttf"),
        Path(r"C:\Windows\Fonts\CascadiaMono.ttf"),
    ]
    for candidate in candidates:
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size=size)
    return ImageFont.load_default()


FONT = load_font(FONT_SIZE)
TITLE_FONT = load_font(TITLE_SIZE)


SCENES = [
    {
        "title": "TelegramSummary Demo",
        "caption": "Local Telegram summarizer with CLI + MCP support",
        "lines": [
            ("PS C:\\TelegramSummary> npm run mcp", ACCENT),
            ("", TEXT),
            ("Telegram Summary MCP server running on stdio", SUCCESS),
            ("", TEXT),
            ("Available tools:", MUTED),
            ("- list_dialogs", TEXT),
            ("- get_dialog_messages", TEXT),
            ("- summarize_dialog", TEXT),
            ("- list_llm_providers", TEXT),
            ("- list_summary_languages", TEXT),
            ("- get_last_summary", TEXT),
        ],
        "hold": 18,
    },
    {
        "title": "MCP Tool Call",
        "caption": "Example summarize_dialog request",
        "lines": [
            ('tool: summarize_dialog', ACCENT),
            ("", TEXT),
            ('{', TEXT),
            ('  "dialogRef": "Chat-gpt公益车队交流",', TEXT),
            ('  "period": "day",', TEXT),
            ('  "mode": "full",', TEXT),
            ('  "provider": "opencode-go-openai",', TEXT),
            ('  "model": "glm-5",', TEXT),
            ('  "language": "en",', TEXT),
            ('  "saveOutputs": true', TEXT),
            ('}', TEXT),
        ],
        "hold": 18,
    },
    {
        "title": "Summary Output",
        "caption": "Structured summary with practical sections",
        "lines": [
            ("Summary created for \"Chat-gpt公益车队交流\" (day).", SUCCESS),
            ("", TEXT),
            ("# Chat summary: Chat-gpt公益车队交流", ACCENT),
            ("", TEXT),
            ("## Key points in 5-10 bullets", WARN),
            ("- Main discussion focused on model routing and response quality.", TEXT),
            ("- Several participants compared GLM-5 and MiniMax outputs.", TEXT),
            ("- A stable SOCKS proxy setup was recommended for Telegram access.", TEXT),
            ("", TEXT),
            ("## Useful information", WARN),
            ("- Incremental mode is better for large chats and lower cost.", TEXT),
            ("- Sender labels now include readable names and Telegram ids.", TEXT),
            ("", TEXT),
            ("## Useful links", WARN),
            ("- https://my.telegram.org -> get Telegram API credentials", TEXT),
        ],
        "hold": 20,
    },
    {
        "title": "Saved Reports",
        "caption": "Markdown, JSON, and HTML artifacts",
        "lines": [
            ("Done.", SUCCESS),
            ("", TEXT),
            ("Messages saved to: output/...messages.json", TEXT),
            ("Summary saved to: output/...summary.md", TEXT),
            ("Structured summary saved to: output/...summary.json", TEXT),
            ("HTML report saved to: output/...summary.html", TEXT),
            ("", TEXT),
            ("Languages: ru, en, es, de, fr, zh-cn", MUTED),
            ("Run modes: full, incremental, changes", MUTED),
            ("Works with MCP clients over stdio", MUTED),
        ],
        "hold": 22,
    },
]


def wrap_line(text: str, width_chars: int = 78) -> list[str]:
    if not text:
        return [""]
    return textwrap.wrap(text, width=width_chars, replace_whitespace=False, drop_whitespace=False)


def render_scene(scene: dict, reveal: int | None = None) -> Image.Image:
    image = Image.new("RGB", (WIDTH, HEIGHT), BG)
    draw = ImageDraw.Draw(image)

    draw.rounded_rectangle(
        (24, 24, WIDTH - 24, HEIGHT - 24),
        radius=24,
        fill=PANEL,
        outline=PANEL_BORDER,
        width=2,
    )

    draw.text((PADDING, 34), scene["title"], font=TITLE_FONT, fill=TEXT)
    draw.text((PADDING, 72), scene["caption"], font=FONT, fill=MUTED)
    draw.rounded_rectangle((PADDING, 118, WIDTH - PADDING, HEIGHT - PADDING), radius=18, fill="#0b1220")

    y = 144
    visible = scene["lines"] if reveal is None else scene["lines"][:reveal]
    for text, color in visible:
        for wrapped in wrap_line(text):
            draw.text((PADDING + 18, y), wrapped, font=FONT, fill=color)
            y += LINE_HEIGHT
        if not text:
            y += 4

    return image


def main() -> None:
    DOCS_DIR.mkdir(parents=True, exist_ok=True)
    frames: list[Image.Image] = []
    durations: list[int] = []

    for scene in SCENES:
        for index in range(1, len(scene["lines"]) + 1):
            frames.append(render_scene(scene, reveal=index))
            durations.append(110)
        for _ in range(scene["hold"]):
            frames.append(render_scene(scene))
            durations.append(100)

    frames[0].save(
        OUTPUT,
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=0,
        disposal=2,
        optimize=False,
    )
    print(OUTPUT)


if __name__ == "__main__":
    main()
