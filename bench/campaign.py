"""Local NInfer measurements and narrowly scoped, reversible server launches."""
import argparse
import concurrent.futures
import json
import os
from pathlib import Path
import signal
import subprocess
import time
import urllib.request
import uuid

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / 'results'
HOME = Path('/home/diffusionlab')
BASE = 'http://127.0.0.1:8080'


def http(path, data=None, timeout=1800):
    request = urllib.request.Request(BASE + path, data=None if data is None else json.dumps(data).encode(), headers={'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def memory():
    gpu = subprocess.check_output(['nvidia-smi', '--query-gpu=memory.used,memory.free,utilization.gpu', '--format=csv,noheader,nounits'], text=True).strip()
    mem = dict(line.split(':', 1) for line in Path('/proc/meminfo').read_text().splitlines())
    return {'gpu_used_free_mib_util_percent': gpu, 'ram': {k: mem[k].strip() for k in ['MemTotal', 'MemAvailable', 'SwapFree', 'Mlocked', 'Unevictable']}}


def generate(label, tokens=1024, output=128, previous=None, protocol='responses'):
    nonce = str(uuid.uuid4())
    # Each row's independent numbers defeat accidental cross-request prefix hits.
    prompt = f'MEMORY_TEST={nonce}\n' + '\n'.join(f'Record {i}: alpha beta gamma delta value {i * 17}.' for i in range(max(1, tokens // 15)))
    prompt += '\nReturn MEMORY_TEST followed by a short summary of the records.'
    if previous:
        prompt = 'What is MEMORY_TEST? Return its exact value, then briefly describe the previous records.'
    body = {'model': 'qwen3.8-27b', 'input': prompt, 'max_output_tokens': output, 'temperature': 0, 'stream': True, 'store': True}
    if previous:
        body['previous_response_id'] = previous
    if protocol == 'chat':
        body = {'model': 'qwen3.8-27b', 'messages': [{'role': 'user', 'content': prompt}], 'max_tokens': output, 'temperature': 0, 'stream': True, 'stream_options': {'include_usage': True}, 'enable_thinking': False}
    else:
        body['reasoning'] = {'effort': 'none'}
    path = '/v1/chat/completions' if protocol == 'chat' else '/v1/responses'
    before = memory()
    start = time.monotonic()
    record = {'label': label, 'requested_context_approx': tokens, 'nonce': nonce, 'protocol': protocol, 'before': before}
    request = urllib.request.Request(BASE + path, data=json.dumps(body).encode(), headers={'Content-Type': 'application/json'})
    pieces = []
    with urllib.request.urlopen(request, timeout=2400) as response:
        record['request_id'] = response.headers.get('x-request-id')
        for raw in response:
            if not raw.startswith(b'data: '):
                continue
            payload = raw[6:].strip()
            if payload == b'[DONE]':
                continue
            event = json.loads(payload)
            if protocol == 'chat':
                delta = (event.get('choices') or [{}])[0].get('delta', {}).get('content', '')
                if event.get('usage'):
                    record['usage'] = event['usage']
            else:
                delta = event.get('delta', '') if event.get('type') == 'response.output_text.delta' else ''
                if event.get('type') in ['response.completed', 'response.incomplete', 'response.failed']:
                    final = event['response']
                    record.update(response_id=final['id'], usage=final.get('usage'), status=final.get('status'), error=final.get('error'))
            if delta:
                record.setdefault('ttft_seconds', time.monotonic() - start)
                pieces.append(delta)
    record.update(total_seconds=time.monotonic() - start, text=''.join(pieces), after=memory())
    with (RESULTS / 'requests.jsonl').open('a') as f:
        f.write(json.dumps(record) + '\n')
    print(json.dumps({k: v for k, v in record.items() if k not in ['text', 'before', 'after']}), flush=True)
    return record


def processes():
    result = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            argv = [os.fsdecode(x) for x in (p / 'cmdline').read_bytes().split(b'\0') if x]
            if argv and argv[0] == str(HOME / 'ninfer/ninfer-serve'):
                result.append((int(p.name), argv))
        except (OSError, ProcessLookupError):
            pass
    return result


def stop():
    for pid, _ in processes():
        os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            try:
                state = Path(f'/proc/{pid}/stat').read_text().split(') ')[1].split()[0]
                if state == 'Z':
                    break
            except FileNotFoundError:
                break
            time.sleep(.25)
        else:
            raise RuntimeError(f'NInfer {pid} did not stop; no forced kill issued')


def launch(label, kv=None, host=8192, restore=False):
    backup = Path((ROOT.parent / 'plans/backup-location.txt').read_text().strip())
    manifest = json.loads((backup / 'manifest.json').read_text())
    args = manifest['ninfer']['argv'].copy()
    if not restore:
        for key, value in [('--max-context', 65536), ('--kv-capacity', kv), ('--max-concurrency', 2)]:
            args[args.index(key) + 1] = str(value)
        args += ['--device-state-slots', '2', '--host-state-slots', '8', '--host-kv-mib', str(host), '--max-private-continuations', '8', '--max-shared-prefixes', '8']
    if label != 'original':
        args += ['--request-log-jsonl', str(RESULTS / f'{label}.server.jsonl')]
    stop()
    output = (RESULTS / f'{label}.stderr.log').open('ab')
    begin = time.monotonic()
    proc = subprocess.Popen(args, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
    (RESULTS / 'active-launch.json').write_text(json.dumps({'pid': proc.pid, 'argv': args, 'label': label}, indent=2) + '\n')
    deadline = begin + 300
    while time.monotonic() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f'{label} startup exited {proc.returncode}; see stderr log')
        try:
            health = http('/health', timeout=2)
            record = {'label': label, 'load_seconds': time.monotonic() - begin, 'health': health, 'memory': memory(), 'argv': args}
            (RESULTS / f'{label}.startup.json').write_text(json.dumps(record, indent=2) + '\n')
            print(json.dumps(record), flush=True)
            return
        except (OSError, ValueError):
            time.sleep(.5)
    raise TimeoutError('Server readiness timeout')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('action', choices=['baseline', 'launch', 'restore', 'smoke', 'queue'])
    parser.add_argument('--kv', type=int, default=65536)
    parser.add_argument('--host', type=int, default=8192)
    parser.add_argument('--label', default='candidate')
    parser.add_argument('--tokens', type=int, default=1024)
    args = parser.parse_args()
    RESULTS.mkdir(exist_ok=True)
    if args.action == 'launch':
        try:
            launch(args.label, args.kv, args.host)
        except Exception:
            launch('original', restore=True)
            raise
    elif args.action == 'restore':
        launch('original', restore=True)
    elif args.action == 'baseline':
        for i in range(3):
            generate(f'baseline-{i}', tokens=1024, protocol='chat')
    elif args.action == 'smoke':
        record = generate(args.label, tokens=args.tokens)
        generate(args.label + '-restore', previous=record['response_id'])
    elif args.action == 'queue':
        start = time.monotonic()
        with concurrent.futures.ThreadPoolExecutor(max_workers=6) as pool:
            results = list(pool.map(lambda i: generate(f'{args.label}-{i}', tokens=args.tokens), range(6)))
        (RESULTS / f'{args.label}.queue.json').write_text(json.dumps({'wall_seconds': time.monotonic() - start, 'requests': results}, indent=2)+'\n')
