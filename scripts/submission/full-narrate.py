#!/usr/bin/env python3
"""Narrate the source-bound Goal016 submission film using the already installed local Nemo.

Reuse the preserved Goal015 signal-processing functions without changing that
script or its source movie. No engine startup/download or external speech API.
"""
import argparse
import array
import importlib.util
import json
import math
from pathlib import Path
import urllib.parse

spec = importlib.util.spec_from_file_location(
    "preserved_nemo_tools", Path(__file__).with_name("narrate.py"))
nemo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nemo)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ("source", "edl", "plan", "work", "out"):
        parser.add_argument("--" + name, type=Path, required=True)
    parser.add_argument("--engine", default="http://127.0.0.1:50121")
    parser.add_argument("--prepared", type=Path,
                        help="Previously measured new chapters from full-prepare-narration.py")
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.engine)
    assert origin.scheme == "http" and origin.hostname == "127.0.0.1"
    assert not origin.path and not origin.query and not origin.fragment
    assert not origin.username and not origin.password
    assert args.source.name == "demo-full.mp4" and args.source.parent.name == "goal016-submission"
    source_sha = nemo.digest(args.source)
    edl = json.loads(args.edl.read_text())
    plan = json.loads(args.plan.read_text())
    assert edl["edition"] == plan["edition"] == "goal016-submission"
    assert edl["sha256"] == plan["sourceSha256"] == source_sha
    assert edl["durationSeconds"] == plan["durationSeconds"]
    duration = edl["durationSeconds"]
    assert 150 <= duration <= 180 and edl["frames"] == round(duration * 25)
    assert plan["captureSha256"] == edl["captureSha256"]
    review = json.loads((args.edl.parent / "review/technical-review.json").read_text())
    assert review["sha256"] == source_sha
    assert review["fullDecode"] == "passed-all" + str(edl["frames"]) + "-frames-no-errors"
    assert review.get("result") != "failed"
    assert plan["segments"] and len(plan["segments"]) <= 30
    previous_until = 0
    ids = set()
    for entry in plan["segments"]:
        assert entry["id"] not in ids and entry["id"].replace("-", "").isalnum()
        ids.add(entry["id"])
        assert entry["startSeconds"] >= previous_until
        assert entry["startSeconds"] < entry["untilSeconds"] <= duration
        scenes = [s for s in edl["scenes"] if s["id"] in entry["sceneIds"]]
        assert len(scenes) == len(entry["sceneIds"]) > 0
        assert [s["id"] for s in scenes] == entry["sceneIds"]
        for before, after in zip(scenes, scenes[1:]):
            assert abs(before["outputEnd"] - after["outputStart"]) < 1e-6
        assert entry["startSeconds"] >= min(s["outputStart"] for s in scenes)
        assert entry["untilSeconds"] <= max(s["outputEnd"] for s in scenes)
        assert entry["text"].strip() and entry["spokenText"].strip()
        previous_until = entry["untilSeconds"]
    # No network access occurs until all local input/story bindings passed.
    version = json.loads(nemo.request(args.engine, "/version"))
    assert version == "0.24.0"
    speakers = json.loads(nemo.request(args.engine, "/speakers"))
    styles = {s["id"]: person["name"] for person in speakers for s in person["styles"]}
    assert styles[10005] == "女声1"
    prepared = None
    if args.prepared:
        prepared = json.loads((args.prepared / "manifest.json").read_text())
        assert prepared["format"] == "ugoku-goal016-submission-prepared-narration-v1"
        assert prepared["edition"] == "goal016-submission"
        assert prepared["sourceScriptSha256"] == plan["scriptSha256"]
        assert prepared["version"] == version and prepared["speaker"] == 10005
        assert prepared["settings"] == nemo.SETTINGS
        assert len({s["id"] for s in prepared["segments"]}) == len(prepared["segments"])
    args.work.mkdir(parents=True, exist_ok=False)
    args.out.mkdir(parents=True, exist_ok=False)
    nemo.save(args.work / "engine.json", dict(version=version, settings=nemo.SETTINGS,
                                              speaker=10005, voice=styles[10005]))
    track = array.array("h", [0]) * round(duration * nemo.RATE)
    segments = []
    for entry in plan["segments"]:
        if prepared:
            matches = [s for s in prepared["segments"] if s["id"] == entry["id"]]
            assert len(matches) == 1
            result = matches[0]
            assert result["text"] == entry["text"] and result["spokenText"] == entry["spokenText"]
            audio_path = Path(result["file"]).resolve()
            assert audio_path.parent == args.prepared.resolve()
            assert not Path(result["file"]).is_symlink()
            assert nemo.digest(audio_path) == result["sha256"]
            samples = nemo.pcm(audio_path)
            assert nemo.levels(samples)["samples"] == result["samples"]
        else:
            result, samples = nemo.synthesize(args.engine, entry["spokenText"], 10005,
                                             args.work, entry["id"])
        end = entry["startSeconds"] + len(samples) / nemo.RATE
        assert end <= entry["untilSeconds"], "Shorten the script; never speed up or trim speech"
        offset = round(entry["startSeconds"] * nemo.RATE)
        track[offset:offset + len(samples)] = samples
        segments.append({**entry, **result, "endSeconds": end})
        print(json.dumps(dict(id=entry["id"], start=entry["startSeconds"], end=end),
                         ensure_ascii=False), flush=True)
    narration = args.out / "narration.wav"
    nemo.wav(narration, track)
    movie = args.out / "demo-full-narrated.mp4"
    credit = "音声：VOICEVOX Nemo（女声1）"
    nemo.ffmpeg("-v", "error", "-i", args.source, "-i", narration,
                "-map", "0:v:0", "-map", "1:a:0", "-c:v", "copy", "-c:a", "aac",
                "-b:a", "160k", "-ar", nemo.RATE, "-map_metadata", "0", "-metadata",
                "comment=" + credit, "-metadata:s:a:0", "language=jpn",
                "-movflags", "+faststart", "-t", duration, movie)
    assert nemo.digest(args.source) == source_sha
    measurement = nemo.ffmpeg("-i", movie, "-af",
                              "loudnorm=I=-18:TP=-2:LRA=7:print_format=json", "-f", "null", "-")
    measured, _ = json.JSONDecoder().raw_decode(measurement[measurement.rfind("{"):])
    assert all(math.isfinite(float(measured[k])) for k in ("input_i", "input_tp"))
    assert -19.5 <= float(measured["input_i"]) <= -16.5
    assert float(measured["input_tp"]) < -1.5
    nemo.save(args.work / "final-aac-loudness.json", measured)
    manifest = dict(format="ugoku-local-nemo-narration-v1", edition="goal016-submission",
                    source=str(args.source.resolve()), sourceSha256=source_sha,
                    edlSha256=nemo.digest(args.edl), planSha256=nemo.digest(args.plan),
                    captureSha256=edl["captureSha256"], movieSha256=nemo.digest(movie),
                    narrationSha256=nemo.digest(narration), durationSeconds=duration,
                    engineVersion=version, voice=styles[10005], speaker=10005,
                    settings=nemo.SETTINGS, segments=segments, videoCodec="copy",
                    audioCodec="aac", credit=credit, narrationLevels=nemo.levels(track),
                    finalAacLoudness=measured, cloudCalls=0, externalSpeechApiCalls=0,
                    humanListening="not verified; objective signal checks are separate")
    if prepared:
        manifest["preparedManifestSha256"] = nemo.digest(args.prepared / "manifest.json")
    nemo.save(args.out / "manifest.json", manifest)
    lines = ["うごく紙工房 — 提出本編のナレーション", "", credit, ""]
    for segment in segments:
        lines.extend([f"{segment['startSeconds']:.3f}–{segment['endSeconds']:.3f}秒 [{segment['id']}]",
                      segment["text"], "読み：" + segment["spokenText"], ""])
    with (args.out / "narration-timed.txt").open("x") as file:
        file.write("\n".join(lines))
    with (args.out / "youtube-audio-credit.txt").open("x") as file:
        file.write(credit + "\n利用条件：https://voicevox.hiroshiba.jp/nemo/term/\n")
    print(json.dumps(dict(movie=str(movie), sha256=nemo.digest(movie),
                         subjectiveListening="not-verified")), flush=True)


if __name__ == "__main__":
    main()
