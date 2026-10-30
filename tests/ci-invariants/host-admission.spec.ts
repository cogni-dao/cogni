// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO
/** Python public seams: parser, durable CAS, crash repair, bounds and input IO.
 * No kernel mutation. Actual Linux/OpenSSH proof belongs to integration_selftest.py.
 * task.5389 / R7 B3. */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";

it("host admission rejects invalid input and preserves durable ordering across failures", () => {
  const script = String.raw`
import sys,json,tempfile,pathlib,os,unittest,copy,time
sys.path.insert(0,sys.argv[1])
from admission import Policy, Engine, Rejected, digest, parse, receive, locked
P={'version':1,'destination':'192.0.2.1','interface':'eth0','ports':[5432,5435], 'owners':{'alpha':{'writerEpoch':'epoch-a','ports':[5432,5435]},'beta':{'writerEpoch':'epoch-b','ports':[5432]}}}
class Kernel:
 def __init__(self): self.value={};self.writes=0;self.fail=False
 def reconcile(self,value):
  if self.fail:raise Rejected('readback_failed')
  if self.value!=value:self.value=copy.deepcopy(value);self.writes+=1
class Tests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
  self.root=pathlib.Path(self.tmp.name);self.k=Kernel();self.now=1000
  self.e=Engine(Policy(P),self.root,self.k,clock=lambda:self.now,boot=lambda:'boot',monotonic=lambda:100)
 def request(self,entries=None,seq=1):
  entries=entries if entries is not None else [{'ipv4':'8.8.8.8','publishedPort':5435,'expiresAt':1100}]
  return {'version':1,'operation':'apply','writerEpoch':'epoch-a','expectedSequence':seq-1,'nextSequence':seq,'snapshotHash':digest(entries),'entries':entries}
 def apply(self,r=None,owner='alpha'):
  return self.e.execute(owner,parse(json.dumps(r or self.request()).encode(),self.e.policy,owner,self.now))
 def test_strict_parser(self):
  for edit in [{'owner':'beta'},{'destination':'1.1.1.1'},{'entries':[{'ipv4':'127.0.0.1','publishedPort':5435,'expiresAt':1100}]},{'version':True},{'entries':[{'ipv4':'8.8.8.8','publishedPort':8080,'expiresAt':1100}]},{'nextSequence':2},{'entries':[{'ipv4':'8.8.8.8','publishedPort':5435,'expiresAt':1601}]}]:
   r=self.request();r.update(edit)
   with self.assertRaises(Rejected):self.apply(r)
  for raw in [b'{}',b'x'*32769,b'{"version":1,"version":1}',b'[]',b'\xff']:
   with self.assertRaises(Rejected):parse(raw,self.e.policy,'alpha',self.now)
 def test_cas_replay_conflict_and_repair(self):
  self.apply();self.assertEqual(self.e.load()['owners']['alpha']['sequence'],1)
  writes=self.k.writes;self.apply();self.assertEqual(self.k.writes,writes)
  r=self.request([{'ipv4':'1.1.1.1','publishedPort':5435,'expiresAt':1100}])
  with self.assertRaises(Rejected):self.apply(r)
  self.apply(self.request(seq=2))
  with self.assertRaises(Rejected):self.apply()
  self.k.value={};self.e.execute('alpha',{'version':1,'operation':'read','writerEpoch':'epoch-a'})
  self.assertTrue(self.k.value)
 def test_pending_is_durable_before_kernel_failure(self):
  self.k.fail=True
  with self.assertRaises(Rejected):self.apply()
  state=self.e.load();self.assertTrue(state['pending']);self.assertEqual(state['owners']['alpha']['sequence'],1)
  self.k.fail=False;self.apply();self.assertFalse(self.e.load()['pending'])
 def test_precommit_crash_leaves_old_sequence(self):
  self.apply();old=self.e.save
  def fail(state):raise OSError('disk failed')
  self.e.save=fail
  with self.assertRaises(OSError):self.apply(self.request(seq=2))
  self.e.save=old;self.assertEqual(self.e.load()['owners']['alpha']['sequence'],1)
 def test_actual_atomic_io_failure_boundaries(self):
  from unittest.mock import patch
  self.apply();real_fsync=os.fsync
  for at in (1,2):
   count=[0]
   def fail(fd):
    count[0]+=1
    if count[0]==at:raise OSError('fsync fault')
    return real_fsync(fd)
   seq=self.e.load()['owners']['alpha']['sequence']
   with patch('admission.os.fsync',side_effect=fail):
    with self.assertRaises(OSError):self.apply(self.request(seq=seq+1))
   state=self.e.load()
   self.assertEqual(state['owners']['alpha']['sequence'],seq+(at==2))
   if at==2:
    self.assertTrue(state['pending']);self.apply(self.request(seq=seq+1))
    self.assertFalse(self.e.load()['pending'])
 def test_epoch_rotation_preserves_order_and_old_epoch_refuses(self):
  self.apply();changed=copy.deepcopy(P);changed['owners']['alpha']['writerEpoch']='rotated'
  next_engine=Engine(Policy(changed),self.root,self.k,clock=lambda:self.now,boot=lambda:'boot',monotonic=lambda:100)
  self.assertEqual(next_engine.load()['owners']['alpha']['sequence'],1)
  with self.assertRaises(Rejected):parse(json.dumps(self.request(seq=2)).encode(),next_engine.policy,'alpha',self.now)
 def test_expired_replay_never_refreshes_grants(self):
  r=self.request();self.apply(r);self.now=1200;self.apply(r)
  self.assertFalse(any(self.k.value.values()));self.assertEqual(self.e.load()['owners']['alpha']['sequence'],1)
  with self.assertRaises(Rejected):self.apply(self.request(seq=2))
 def test_union_max_expiry_and_dead_owner(self):
  self.apply(self.request([{'ipv4':'8.8.8.8','publishedPort':5432,'expiresAt':1050}]))
  r=self.request([{'ipv4':'8.8.8.8','publishedPort':5432,'expiresAt':1150}]);r['writerEpoch']='epoch-b';self.apply(r,'beta')
  self.assertEqual(self.k.value[5432]['8.8.8.8'],1150)
  self.now=1060;self.e.execute('alpha',{'version':1,'operation':'read','writerEpoch':'epoch-a'})
  self.assertEqual(self.k.value[5432]['8.8.8.8'],1150)
  self.now=1200;self.e.execute('alpha',{'version':1,'operation':'read','writerEpoch':'epoch-a'});self.assertFalse(any(self.k.value.values()))
 def test_overflow_before_commit(self):
  entries=[{'ipv4':'8.1.1.'+str(i),'publishedPort':5432,'expiresAt':1100} for i in range(1,129)]
  self.apply(self.request(entries));before=(self.root/'checkpoint.json').read_bytes()
  r=self.request([{'ipv4':'1.1.1.1','publishedPort':5432,'expiresAt':1100}]);r['writerEpoch']='epoch-b'
  with self.assertRaises(Rejected):self.apply(r,'beta')
  self.assertEqual((self.root/'checkpoint.json').read_bytes(),before)
  with self.assertRaises(Rejected):self.apply(self.request(entries+[entries[0]]))
 def test_clock_rollback_fails_closed(self):
  self.apply();self.now=900
  with self.assertRaises(Rejected):self.e.execute('alpha',{'version':1,'operation':'read','writerEpoch':'epoch-a'})
  self.assertFalse(any(self.k.value.values()))
 def test_lock_before_stdin_and_eof_bounds(self):
  with locked(self.root):
   with self.assertRaises(Rejected):
    with locked(self.root):self.fail('second lock acquired')
  r,w=os.pipe();os.write(w,b'{}');os.close(w)
  try:self.assertEqual(receive(r),b'{}')
  finally:os.close(r)
  r,w=os.pipe()
  try:
   with self.assertRaises(Rejected):receive(r,seconds=.03)
  finally:os.close(r);os.close(w)
unittest.main(argv=['host-admission'],verbosity=2)
`;
  expect(() =>
    execFileSync(
      "python3",
      ["-B", "-c", script, path.resolve("infra/compose/edge/host-admission")],
      { timeout: 10000, stdio: "pipe" }
    )
  ).not.toThrow();
});
