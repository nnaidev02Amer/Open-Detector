"""Command line: python -m detector.cli file.txt   (or pipe text on stdin)."""
import argparse
import json
import sys

from .analysis import analyze_document


def main() -> None:
    ap = argparse.ArgumentParser(description="Score a text file for AI-generated writing style.")
    ap.add_argument("file", nargs="?", help="UTF-8 text file (default: stdin)")
    ap.add_argument("--json", action="store_true", help="print full JSON result")
    a = ap.parse_args()
    text = open(a.file, encoding="utf-8").read() if a.file else sys.stdin.read()
    r = analyze_document(text)
    if a.json:
        print(json.dumps(r.to_dict(), indent=2))
        return
    print(f"status: {r.status}  words: {r.words}")
    if r.status != "ok":
        print(r.message)
        return
    print(f"overall AI score: {r.overall_score*100:.1f}%  verdict: {r.verdict}  ({'calibrated' if r.calibrated else 'raw'})")
    for p in r.paragraphs:
        print(f"  paragraph {p.index+1}: {p.words:4d} words  " + (f"{p.score*100:5.1f}%" if p.scored else "  skipped"))


if __name__ == "__main__":
    main()
