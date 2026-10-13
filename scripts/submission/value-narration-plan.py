#!/usr/bin/env python3
"""Bind the frozen chapters and measured local voice to the completed film EDL."""
import argparse
import hashlib
import json
from pathlib import Path


def read(path):
    data = path.read_bytes()
    return json.loads(data), hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    for name in ('edl', 'script', 'prepared', 'out'):
        parser.add_argument('--' + name, type=Path, required=True)
    args = parser.parse_args()
    edl, edl_sha = read(args.edl)
    script, script_sha = read(args.script)
    prepared, prepared_sha = read(args.prepared)
    assert edl['edition'] == script['edition'] == prepared['edition'] == 'goal016-value-first'
    assert prepared['sourceScriptSha256'] == script_sha
    assert 150 <= edl['durationSeconds'] <= 180
    assert len(prepared['segments']) == len(script['chapters'])
    segments, used = [], []
    for chapter in script['chapters']:
        scenes = [s for s in edl['scenes'] if s['id'] in chapter['sceneIds']]
        assert [s['id'] for s in scenes] == chapter['sceneIds']
        assert scenes
        for before, after in zip(scenes, scenes[1:]):
            assert abs(before['outputEnd'] - after['outputStart']) < 1e-6
        matches = [s for s in prepared['segments'] if s['id'] == chapter['id']]
        assert len(matches) == 1
        measured = matches[0]
        assert all(measured[k] == chapter[k] for k in ('text', 'spokenText'))
        start, until = round(scenes[0]['outputStart'] + .10, 3), round(scenes[-1]['outputEnd'] - .10, 3)
        assert start + measured['durationSeconds'] <= until, 'Shorten speech; do not stretch footage'
        assert not segments or start >= segments[-1]['untilSeconds']
        used.extend(chapter['sceneIds'])
        segments.append({**{k: chapter[k] for k in ('id', 'sceneIds', 'text', 'spokenText')},
                         'startSeconds': start, 'untilSeconds': until})
    assert used == [s['id'] for s in edl['scenes']], 'Every scene must belong to one ordered chapter'
    plan = dict(edition=edl['edition'], sourceSha256=edl['sha256'], edlSha256=edl_sha,
                scriptSha256=script_sha, preparedManifestSha256=prepared_sha,
                captureSha256=edl['captureSha256'], durationSeconds=edl['durationSeconds'],
                segments=segments, cloudCalls=0, newModelCalls=0)
    with args.out.open('x') as file:
        file.write(json.dumps(plan, ensure_ascii=False, indent=2) + '\n')
    args.out.chmod(0o600)
    print(json.dumps(dict(chapters=len(segments), durationSeconds=edl['durationSeconds'],
                         allMeasuredSpeechFits=True)))


if __name__ == '__main__':
    main()
