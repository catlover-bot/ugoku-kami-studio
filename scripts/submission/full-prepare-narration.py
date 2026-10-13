#!/usr/bin/env python3
"""Measure newly written chapters on the existing loopback Nemo before editing.

No time stretching, cloud call or file replacement. The final assembler can use
these exact new chapter bytes after checking their text and voice settings.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import urllib.parse

spec = importlib.util.spec_from_file_location(
    'nemo_tools', Path(__file__).with_name('narrate.py'))
nemo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(nemo)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--script', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--engine', default='http://127.0.0.1:50121')
    args = parser.parse_args()
    origin = urllib.parse.urlsplit(args.engine)
    assert origin.scheme == 'http' and origin.hostname == '127.0.0.1'
    assert not any([origin.path, origin.query, origin.fragment, origin.username, origin.password])
    script_bytes = args.script.read_bytes()
    script_sha = hashlib.sha256(script_bytes).hexdigest()
    script = json.loads(script_bytes)
    assert script['edition'] == 'goal016-submission'
    assert script['voice']['speaker'] == 10005 and script['voice']['speedScale'] == 1
    chapters = script['chapters']
    assert 1 <= len(chapters) <= 30
    assert len({c['id'] for c in chapters}) == len(chapters)
    for c in chapters:
        assert c['id'].replace('-', '').isalnum()
        assert c['text'].strip() and c['spokenText'].strip()
    version = json.loads(nemo.request(args.engine, '/version'))
    assert version == '0.24.0'
    speakers = json.loads(nemo.request(args.engine, '/speakers'))
    assert any(s['id'] == 10005 and p['name'] == '女声1' for p in speakers for s in p['styles'])
    args.out.mkdir(parents=True, exist_ok=False)
    results = []
    for c in chapters:
        result, _ = nemo.synthesize(args.engine, c['spokenText'], 10005, args.out, c['id'])
        entry = {**result, 'id': c['id'], 'text': c['text'], 'spokenText': c['spokenText']}
        results.append(entry)
        print(json.dumps({'id': c['id'], 'speechSeconds': result['durationSeconds'],
                          'preferredSeconds': c['preferredSeconds'],
                          'spareSeconds': c['preferredSeconds']-result['durationSeconds']},
                         ensure_ascii=False), flush=True)
    assert args.script.read_bytes() == script_bytes, 'Chapter script changed during preparation'
    manifest = dict(format='ugoku-goal016-submission-prepared-narration-v1',
                    edition=script['edition'], sourceScriptSha256=script_sha,
                    version=version, speaker=10005, voice='女声1', settings=nemo.SETTINGS,
                    segments=results, cloudCalls=0, externalSpeechApiCalls=0,
                    subjectiveListening='not-verified')
    nemo.save(args.out / 'manifest.json', manifest)


if __name__ == '__main__':
    main()
