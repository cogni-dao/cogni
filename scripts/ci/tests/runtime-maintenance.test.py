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
installer = load('runtime-guard-install')
ID = 'b9d19a15-95f9-41b4-bcf5-cd56142c0eb2'
OTHER_ID = '36d7c53d-3a41-4e5d-b44d-cf5fbedbfb24'

class NativeContracts(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for module in (guard, gateway.guard, receipt, gateway.receipt, installer, installer.guard, installer.receipt):
            self.enterContext(patch.object(module, 'OWNER_UID', os.geteuid()))
        self.enterContext(patch.object(guard, 'ROOT', self.root / 'guard'))
        self.enterContext(patch.object(receipt, 'RECEIPT', self.root / 'receipt.json'))
        self.enterContext(patch.object(installer.guard, 'ROOT', guard.ROOT))

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
            with self.assertRaisesRegex(guard.GuardError, 'runtime_guard_busy'):
                with guard.RuntimeGuard(wait_seconds=0):
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

    def test_two_ordinary_writers_wait_and_finish_serially(self):
        script = '''import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.ROOT=Path(sys.argv[2]);m.OWNER_UID=os.geteuid()
with m.RuntimeGuard(wait_seconds=2):
 print('entered',flush=True)
 sys.stdin.readline()
'''
        args = ['python3', '-c', script, str(LIB / 'runtime-maintenance-guard.py'), str(guard.ROOT)]
        first = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        second = None
        try:
            self.assertEqual(first.stdout.readline().strip(), 'entered')
            second = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
            self.assertIsNone(second.poll())
            first.communicate('\n', timeout=2)
            self.assertEqual(first.returncode, 0)
            output, error = second.communicate('\n', timeout=2)
            self.assertEqual((second.returncode, output.strip(), error), (0, 'entered', ''))
        finally:
            for child in (first, second):
                if child and child.poll() is None:
                    child.kill(); child.communicate(timeout=2)

    def test_exec_preserves_lock_and_nested_installer_can_reenter(self):
        child = '''import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.ROOT=Path(sys.argv[2]);m.OWNER_UID=os.geteuid()
with m.RuntimeGuard(wait_seconds=0):
 print('inherited',flush=True)
 sys.stdin.readline()
'''
        parent = '''import importlib.util,os,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('guard',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.ROOT=Path(sys.argv[2]);m.OWNER_UID=os.geteuid()
with m.RuntimeGuard() as guard:
 guard.exec([sys.executable,'-c',sys.argv[3],sys.argv[1],sys.argv[2]])
'''
        process = subprocess.Popen(['python3', '-c', parent, str(LIB / 'runtime-maintenance-guard.py'), str(guard.ROOT), child],
                                   stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertEqual(process.stdout.readline().strip(), 'inherited')
            with self.assertRaisesRegex(guard.GuardError, 'busy'):
                with guard.RuntimeGuard(wait_seconds=0):
                    self.fail('exec released the host lock')
            output, error = process.communicate('\n', timeout=2)
            self.assertEqual((process.returncode, output, error), (0, '', ''))
        finally:
            if process.poll() is None:
                process.kill(); process.communicate(timeout=2)

    def test_first_guard_install_has_no_gateway_enablement_or_runtime_effect(self):
        target = guard.ROOT / 'lib'
        self.assertFalse(target.exists())
        self.enterContext(patch.object(installer, 'recover_caller', return_value=None))
        result = installer.install('a' * 40)
        self.assertIsNone(result['recoveryCaller'])
        for name, fingerprint in result['blobs'].items():
            self.assertEqual(receipt.digest((target / name).read_bytes()), fingerprint)
        self.assertTrue((guard.ROOT / 'guard.json').is_file())
        self.assertFalse((guard.ROOT / 'source.json').exists())

    def test_guard_install_refuses_pending_activation_before_installing_files(self):
        with guard.RuntimeGuard():
            self.journal('render_installed')
        caller = self.enterContext(patch.object(installer, 'recover_caller'))
        with self.assertRaisesRegex(installer.guard.GuardError, 'reconcile_required'):
            installer.install('a' * 40)
        caller.assert_not_called()
        self.assertFalse((guard.ROOT / 'lib').exists())

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

    def test_render_rename_lost_response_resumes_without_replacing_installed_bytes(self):
        host = self.host('prepared')
        desired = b'OPENROUTER_API_KEY=sk-new-fixture\n'
        env = self.root / 'runtime.env'
        receipt.atomic(env, desired)
        receipt.atomic(host.directory / 'desired.env', desired)
        host.journal.update({'beforeEnvSha256': 'd' * 64, 'desiredEnvSha256': receipt.digest(desired)})
        self.enterContext(patch.object(gateway, 'ENV_FILE', env))
        self.enterContext(patch.object(gateway.receipt, 'read_bytes', return_value=b'prior'))
        host.journal['beforeReceiptSha256'] = receipt.digest(b'prior')
        self.enterContext(patch.object(gateway, 'container', return_value={'Id': 'old-container'}))
        self.enterContext(patch.object(host, 'gateway_matches', return_value=True))
        original_atomic = gateway.atomic
        writes = self.enterContext(patch.object(gateway, 'atomic', wraps=original_atomic))
        host.install_render()
        self.assertEqual(host.journal['state'], 'render_installed')
        self.assertEqual(env.read_bytes(), desired)
        self.assertFalse(any(call.args[0] == env for call in writes.call_args_list))

    def test_receipt_commit_resumes_before_and_after_atomic_publication(self):
        for phase, published in [('gateway_verified', False), ('receipt_commit_started', False), ('receipt_commit_started', True)]:
            with self.subTest(phase=phase, published=published):
                host = self.host(phase)
                prior = receipt.canonical(receipt.seal(self.core())) + b'\n'
                desired_value = self.core()
                desired_value['recoveryServiceConfigSha256'] = receipt.digest(receipt.canonical({'services': {s: {} for s in ('postgres', 'litellm', 'autoheal')}}))
                desired_value['completedAt'] = '2026-11-05T00:00:00Z'
                desired = receipt.canonical(receipt.seal(desired_value)) + b'\n'
                live = self.root / 'live-receipt.json'
                self.enterContext(patch.object(gateway.receipt, 'RECEIPT', live))
                for path, data in [(host.directory / 'before-receipt.json', prior),
                                   (host.directory / 'desired-receipt.json', desired), (live, desired if published else prior)]:
                    receipt.atomic(path, data)
                host.journal.update({'beforeReceiptSha256': receipt.digest(prior), 'desiredReceiptSha256': receipt.digest(desired)})
                self.enterContext(patch.object(host, 'gateway_matches', return_value=True))
                self.enterContext(patch.object(gateway, 'wait_gateway'))
                self.enterContext(patch.object(gateway, 'config', return_value={'services': {s: {} for s in ('postgres', 'litellm', 'autoheal')}}))
                self.enterContext(patch.object(gateway, 'now', return_value='2026-11-05T00:00:00Z'))
                original_commit = gateway.receipt.commit
                commits = self.enterContext(patch.object(gateway.receipt, 'commit', wraps=original_commit))
                host.commit_receipt()
                self.assertEqual(host.journal['state'], 'activated')
                self.assertEqual(live.read_bytes(), desired)
                self.assertEqual(commits.call_count, 0 if published else 1)

    def test_superseded_render_or_app_recovers_then_admits_a_new_operation(self):
        for reason in ('gateway_binding_superseded', 'gateway_app_changed'):
            with self.subTest(reason=reason):
                host = self.host('render_installed')
                host.directory = guard.ROOT / 'operations' / ID
                guard.private_directory(host.directory)
                host.path = host.directory / 'operation.json'
                env = self.root / 'runtime.env'
                old = b'OPENROUTER_API_KEY=sk-old-fixture\nOTHER=unchanged\n'
                desired = b'OPENROUTER_API_KEY=sk-new-fixture\nOTHER=unchanged\n'
                prior = receipt.canonical(receipt.seal(self.core())) + b'\n'
                self.enterContext(patch.object(gateway, 'ENV_FILE', env))
                self.enterContext(patch.object(gateway.receipt, 'RECEIPT', self.root / 'before-receipt.json'))
                for path, data in [(env, desired), (host.directory / 'before.env', old),
                                   (host.directory / 'before-receipt.json', prior), (gateway.receipt.RECEIPT, prior)]:
                    receipt.atomic(path, data)
                host.journal.update({'version': 1, 'operationId': ID, 'appSha': 'a' * 40, 'appImages': ['prior-app'],
                                     'imageId': 'sha256:' + 'e' * 64, 'untouchedRuntime': {},
                                     'beforeEnvSha256': receipt.digest(old), 'desiredEnvSha256': receipt.digest(desired),
                                     'beforeReceiptSha256': receipt.digest(prior),
                                     'projection': {'keySha256': 'b' * 64, 'uid': 'projection', 'resourceVersion': '2'}})
                self.enterContext(patch.object(host, 'selected', side_effect=gateway.GatewayConflict(reason)))
                self.enterContext(patch.object(host, 'gateway_matches', return_value=True))
                self.enterContext(patch.object(gateway, 'wait_gateway'))
                self.enterContext(patch.object(gateway, 'app_images', return_value=['new-app']))
                self.enterContext(patch.object(gateway, 'app_sha', return_value='b' * 40))
                effect = self.enterContext(patch.object(gateway, 'run'))
                with guard.RuntimeGuard(ID):
                    host.save('render_installed')
                with self.assertRaisesRegex(guard.GuardError, 'reconcile_required'):
                    with guard.RuntimeGuard(wait_seconds=0):
                        pass
                with guard.RuntimeGuard(ID):
                    observed = host.reconcile_conflict(reason)
                self.assertEqual(env.read_bytes(), old)
                self.assertEqual(gateway.receipt.RECEIPT.read_bytes(), prior)
                self.assertEqual(observed['phase'], 'rolled_back')
                self.assertFalse(observed['evidence']['appPreserved'])
                effect.assert_not_called()
                with guard.RuntimeGuard(OTHER_ID):
                    pass

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
