"""
Tests for strip_ansi — the ANSI escape code removal utility.

Covers common escape sequences found in tmux-captured terminal output:
SGR color codes, cursor movements, OSC window titles, and
carriage-return based progress bar overwrites.
"""

import sys
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "server", "tools"))

import strip_ansi_filter  # noqa: E402

# Import the regex-based stripping function for testing
def strip_ansi(text: str) -> str:
    """Apply the same transformations as the filter script."""
    text = strip_ansi_filter._ANSI_RE.sub("", text)
    text = strip_ansi_filter._CR_OVERWRITE_RE.sub("", text)
    return text


class TestBasicSGR:
    """Standard Select Graphic Rendition sequences (colors, bold, etc.)."""

    def test_single_color(self):
        assert strip_ansi("\x1b[31mERROR\x1b[0m") == "ERROR"

    def test_bold(self):
        assert strip_ansi("\x1b[1mBold text\x1b[0m") == "Bold text"

    def test_multi_param(self):
        assert strip_ansi("\x1b[1;32;40mGreen on Black\x1b[0m") == "Green on Black"

    def test_256_color(self):
        assert strip_ansi("\x1b[38;5;196mRed256\x1b[0m") == "Red256"

    def test_truecolor(self):
        assert strip_ansi("\x1b[38;2;255;0;0mTrueRed\x1b[0m") == "TrueRed"

    def test_reset_only(self):
        assert strip_ansi("\x1b[0m") == ""


class TestCursorAndScreen:
    """Cursor movement, screen clearing, etc."""

    def test_clear_screen(self):
        assert strip_ansi("\x1b[2JCleared") == "Cleared"

    def test_cursor_home(self):
        assert strip_ansi("\x1b[HHome") == "Home"

    def test_cursor_position(self):
        assert strip_ansi("\x1b[10;20HAt pos") == "At pos"

    def test_erase_line(self):
        assert strip_ansi("\x1b[KLine cleared") == "Line cleared"

    def test_scroll_up(self):
        assert strip_ansi("\x1b[2SScrolled") == "Scrolled"


class TestOSC:
    """Operating System Command sequences (window titles, etc.)."""

    def test_set_title_bel(self):
        assert strip_ansi("\x1b]0;My Window Title\x07Content") == "Content"

    def test_set_title_st(self):
        assert strip_ansi("\x1b]2;Title\x1b\\Content") == "Content"


class TestSimpleEscapes:
    """Single-character escape sequences."""

    def test_charset_switch(self):
        # ESC(B is a common charset switch
        assert strip_ansi("\x1b(BNormal text") == "Normal text"


class TestCarriageReturn:
    """Progress bar / spinner overwrite patterns using \\r."""

    def test_progress_bar_overwrite(self):
        text = "Downloading: 50%\rDownloading: 100%\n"
        result = strip_ansi(text)
        assert "100%" in result
        # The intermediate 50% state should be collapsed
        assert result.count("Downloading") == 1

    def test_single_cr_before_newline_preserved(self):
        # \r\n should be preserved (Windows line ending)
        text = "Line 1\r\nLine 2\r\n"
        assert strip_ansi(text) == text


class TestPassthrough:
    """Clean text should pass through unchanged."""

    def test_plain_text(self):
        text = "Hello, world! This is a normal log line."
        assert strip_ansi(text) == text

    def test_empty_string(self):
        assert strip_ansi("") == ""

    def test_multiline(self):
        text = "Line 1\nLine 2\nLine 3\n"
        assert strip_ansi(text) == text

    def test_numbers_and_symbols(self):
        text = "loss=0.0123 | accuracy=99.5% | epoch 10/50"
        assert strip_ansi(text) == text


class TestMixedContent:
    """Real-world scenarios with mixed ANSI codes and content."""

    def test_pytorch_training_output(self):
        raw = (
            "\x1b[1m\x1b[34mEpoch 1/10\x1b[0m: "
            "\x1b[32mloss=0.4521\x1b[0m | "
            "\x1b[33macc=0.85\x1b[0m"
        )
        result = strip_ansi(raw)
        assert result == "Epoch 1/10: loss=0.4521 | acc=0.85"

    def test_tqdm_style_bar(self):
        raw = (
            "\r\x1b[32m 50%\x1b[0m|████     | 50/100"
            "\r\x1b[32m100%\x1b[0m|█████████| 100/100\n"
        )
        result = strip_ansi(raw)
        assert "100/100" in result
        assert "\x1b" not in result
