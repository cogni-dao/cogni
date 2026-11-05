#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""Bounded native lock, crash-journal, receipt-CAS and gateway-resume contracts."""
import copy
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

LIB = Path(__file__).resolve().parents[1] / 'lib'

def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), LIB / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

guard = load('runtime-maintenance-guard')
receipt = load('runtime-recovery-receipt')
gateway = load('gateway-activation-host')
ID = 'b9d19a15-95f9-41b4-bcf5-cd56142c0eb2'
OTHER_ID = '36d7c53d-3a41-4e5d-b44d-cf5fbedbfb24'

class NativeContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for module in (guard, gateway.guard, receipt, gateway.receipt):
            self.enterContext(patch.object(module, 'OWNER_UID', os.geteuid()))
        self.enterContext(patch.object(guard, 'ROOT', self.root / 'guard'))
        self.enterContext(patch.object(receipt, 'RECEIPT', self.root / 'receipt.json'))

    def journal(self, state):
        directory = guard.ROOT / 'operations' / ID
        guard.private_directory(directory)
        receipt.atomic(directory / 'operation.json', json.dumps({'version': 1, 'operationId': ID, 'state': state}).encode())

    def test_exclusive_lock_and_durable_refusal_after_process_loss(self):
        script = '''import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.ROOT=Path(sys.argv[2]);m.OWNER_UID=os.geteuid()
with m.RuntimeGuard():
 print('held',flush=True)
 sys.stdin.readline()
'''
        child = subprocess.Popen(['python3', '-c', script, str(LIB / 'runtime-maintenance-guard.py'), str(guard.ROOT)],
                                 stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(child.stdout.readline().strip(), 'held')
            with self.assertRaises(BlockingIOError):
                with guard.RuntimeGuard():
                    self.fail('second writer entered')
            self.journal('recreate_started')
            child.kill()
            child.wait(timeout=5)
            with self.assertRaisesRegex(guard.GuardError, 'reconcile_required'):
                with guard.RuntimeGuard():
                    self.fail('ordinary writer entered unfinished operation')
            with guard.RuntimeGuard(ID):
                pass
            with self.assertRaisesRegex(guard.GuardError, 'reconcile_required'):
                with guard.RuntimeGuard(OTHER_ID):
                    self.fail('foreign activation entered')
        finally:
            if child.poll() is None:
                child.kill()
            child.communicate(timeout=5)

    def test_partial_prepare_blocks_other_writers(self):
        with guard.RuntimeGuard():
            guard.private_directory(guard.ROOT / 'operations' / ID)
        with self.assertRaisesRegex(guard.GuardError, 'reconcile_required'):
            with guard.RuntimeGuard():
                pass
        with guard.RuntimeGuard(ID):
            pass

    def test_terminal_journal_allows_normal_reconcile(self):
        with guard.RuntimeGuard():
            self.journal('activated')
        with guard.RuntimeGuard():
            pass

    def test_symlinked_journal_is_never_read(self):
        with guard.RuntimeGuard():
            directory = guard.ROOT / 'operations' / ID
            guard.private_directory(directory)
            (directory / 'operation.json').symlink_to('/etc/passwd')
        with self.assertRaisesRegex(guard.GuardError, 'journal_invalid'):
            with guard.RuntimeGuard(ID):
                pass

    def test_unknown_journal_version_refuses_even_owner(self):
        with guard.RuntimeGuard():
            self.journal('activated')
        path = guard.ROOT / 'operations' / ID / 'operation.json'
        receipt.atomic(path, json.dumps({'version': 2, 'operationId': ID, 'state': 'activated'}).encode())
        with self.assertRaisesRegex(guard.GuardError, 'journal_invalid'):
            with guard.RuntimeGuard(ID):
                pass

    def core(self):
        return {'version': 2, 'composeSha256': 'a' * 64, 'litellmConfigSha256': 'b' * 64,
                'recoveryServiceConfigSha256': 'c' * 64, 'sourceRef': 'a' * 40,
                'completedAt': '2026-11-04T00:00:00Z',
                'images': {s: {'ref': s + ':pinned', 'id': 'sha256:' + 'd' * 64}
                           for s in ('postgres', 'litellm', 'autoheal')}}

    def test_receipt_codec_matches_existing_jq_wire_and_rejects_tampering(self):
        value = receipt.seal(self.core())
        raw = subprocess.check_output(['jq', '-cS', '.'], input=json.dumps(self.core()).encode()).rstrip(b'\n')
        self.assertEqual(value['declarationDigest'], receipt.digest(raw))
        value['recoveryServiceConfigSha256'] = 'e' * 64
        with self.assertRaisesRegex(receipt.ReceiptError, 'digest_invalid'):
            receipt.validate(value)

    def test_receipt_create_and_compare_swap_preserve_winner(self):
        before = receipt.seal(self.core())
        old_hash = receipt.commit(before, None)
        changed = self.core()
        changed['recoveryServiceConfigSha256'] = 'e' * 64
        after = receipt.seal(changed)
        new_hash = receipt.commit(after, old_hash)
        self.assertNotEqual(new_hash, old_hash)
        with self.assertRaisesRegex(receipt.ReceiptError, 'changed'):
            receipt.commit(before, old_hash)
        self.assertEqual(receipt.read(), after)
        with self.assertRaisesRegex(receipt.ReceiptError, 'already_exists'):
            receipt.commit(before, None)

    def host(self, phase):
        host = object.__new__(gateway.Host)
        host.intent = {'operationId': ID}
        host.directory = self.root
        host.path = self.root / 'operation.json'
        host.journal = {'state': phase, 'beforeContainerId': 'old-container', 'beforeProviderKeySha256': 'a' * 64,
                        'projection': {'keySha256': 'b' * 64}, 'beforeReceiptSha256': 'c' * 64}
        self.enterContext(patch.object(host, 'preserved'))
        self.enterContext(patch.object(host, 'selected'))
        self.enterContext(patch.object(host, 'render_matches'))
        return host

    def test_adopted_container_after_lost_response_is_not_recreated(self):
        host = self.host('recreate_started')
        self.enterContext(patch.object(host, 'gateway_matches', return_value=True))
        self.enterContext(patch.object(gateway, 'wait_gateway'))
        effect = self.enterContext(patch.object(gateway, 'run'))
        host.activate()
        effect.assert_not_called()
        self.assertEqual(json.loads(host.path.read_text())['state'], 'gateway_verified')

    def test_unknown_container_is_not_recreated_or_compensated(self):
        host = self.host('recreate_started')
        self.enterContext(patch.object(host, 'gateway_matches', return_value=False))
        self.enterContext(patch.object(gateway, 'container', return_value={'Id': 'foreign-container'}))
        effect = self.enterContext(patch.object(gateway, 'run'))
        with self.assertRaisesRegex(gateway.GatewayConflict, 'unknown_container'):
            host.activate()
        effect.assert_not_called()

    def test_superseded_projection_refuses_before_any_effect(self):
        host = self.host('render_installed')
        self.enterContext(patch.object(host, 'selected', side_effect=gateway.GatewayConflict('gateway_binding_superseded')))
        effect = self.enterContext(patch.object(gateway, 'run'))
        with self.assertRaisesRegex(gateway.GatewayConflict, 'binding_superseded'):
            host.activate()
        effect.assert_not_called()

    def test_provider_render_replaces_one_line_and_preserves_unrelated_bytes(self):
        raw = b'# comment\nOTHER=untouched\nOPENROUTER_API_KEY=sk-old-fixture\nTRAILING=kept\n'
        self.assertEqual(gateway.replace_provider(raw, 'sk-new-fixture'), raw.replace(b'sk-old-fixture', b'sk-new-fixture'))
        with self.assertRaises(RuntimeError):
            gateway.replace_provider(raw + b'OPENROUTER_API_KEY=sk-duplicate\n', 'sk-new-fixture')

    def test_same_contract_refuses_foreign_binding_and_raw_values(self):
        intent = {'version': 1, 'operationId': ID, 'target': 'litellm-provider-key', 'env': 'preview',
                  'custodian': {'owner': 'cogni-dao', 'repo': 'cogni', 'controlEnv': 'production'},
                  'implementationSha': 'a' * 40, 'protocolVersion': 1,
                  'bindingRef': 'cogni/preview/operator/OPENROUTER_API_KEY'}
        self.assertEqual(gateway.validate_intent(intent), intent)
        for change in ({'value': 'sk-fictional'}, {'env': 'production'}):
            with self.assertRaises(gateway.GatewayConflict):
                gateway.validate_intent({**copy.deepcopy(intent), **change})

if __name__ == '__main__':
    unittest.main()
