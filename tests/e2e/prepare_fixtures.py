"""Creates the sample files the browser tests upload. Usage: python prepare_fixtures.py <work_dir>

Everything is generated locally from the repository's own test texts and the guide PDF fixture; nothing is downloaded.
"""
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "tests"))
from conftest import AI_TEXT, HUMAN_TEXT  # noqa: E402
from docx import Document  # noqa: E402

work = Path(sys.argv[1])
work.mkdir(parents=True, exist_ok=True)
both = AI_TEXT + "\n\n" + HUMAN_TEXT
(work / "sample.txt").write_text(both, encoding="utf-8")
(work / "sample.md").write_text("# Notes\n\n" + AI_TEXT + "\n\n## More\n\n" + HUMAN_TEXT, encoding="utf-8")
(work / "ai.txt").write_text(AI_TEXT + "\n\n" + AI_TEXT, encoding="utf-8")
(work / "short.txt").write_text("far too short for the detector", encoding="utf-8")
d = Document(); d.add_paragraph(AI_TEXT); d.add_paragraph(HUMAN_TEXT); d.save(work / "sample.docx")
shutil.copy(ROOT / "tests" / "fixtures" / "Browser_Fingerprinting_Project_Simple_Guide.pdf", work / "guide.pdf")
(work / "bad.exe").write_bytes(b"MZ\x90\x00")
(work / "empty.txt").write_bytes(b"")
(work / "big.txt").write_bytes(b"a" * (10 * 1024 * 1024 + 1))
(work / "corrupt.pdf").write_bytes(b"%PDF-1.4 broken")
print(f"fixtures written to {work}")
