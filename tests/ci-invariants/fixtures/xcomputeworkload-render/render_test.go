// Actual text/template + sprig execution of the committed Composition, without a
// cluster, credentials, provider calls or a mirrored identity implementation.
package render_test

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"os"
	"reflect"
	"sort"
	"strings"
	"testing"
	"text/template"

	"github.com/Masterminds/sprig/v3"
	"gopkg.in/yaml.v3"
)

var compositionPath = flag.String("composition", "../../../../infra/crossplane/xcomputeworkload/composition.yaml", "Composition under test (override for regression sensitivity proof)")

type obj = map[string]interface{}

const node = "b927a9dd-6132-4fc9-a51e-e3cee2568e3c"
const host = "node-template-test.cognidao.org"
const blue = "blue.ingress.example"
const green = "green.ingress.example"
const annotation = "gotemplating.fn.crossplane.io/composition-resource-name"

func key(g int) string { return fmt.Sprintf("xcw:cogni-candidate-a:%s:%d", node, g) }
func at(m obj, keys ...string) interface{} {
	var v interface{} = m
	for _, k := range keys {
		o, ok := v.(map[string]interface{})
		if !ok {
			return nil
		}
		v = o[k]
	}
	return v
}
func jsonString(v interface{}) string {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return string(b)
}
func fixture(g int) obj {
	return obj{
		"observed": obj{
			"composite": obj{"resource": obj{
				"apiVersion": "compute.cogni.io/v1alpha1", "kind": "XComputeWorkload",
				"metadata": obj{"name": node, "namespace": "cogni-candidate-a", "uid": "xr-uid", "generation": 154, "creationTimestamp": "2026-10-30T00:00:00Z"},
				"spec": obj{
					"nodeId": node, "environment": "candidate-a", "leaseGeneration": g,
					"bundle":   obj{"ref": "ghcr.io/cogni/test@sha256:" + strings.Repeat("a", 64), "source": obj{"sha": strings.Repeat("b", 40), "repository": "https://github.com/Cogni-DAO/node-template"}, "artifacts": []interface{}{obj{"name": "app", "image": "ghcr.io/cogni/app@sha256:" + strings.Repeat("c", 64)}}},
					"workload": obj{"name": "node-template", "publicHost": host, "services": []interface{}{obj{"name": "app", "artifact": "app", "visibility": "public", "bindHost": "0.0.0.0", "port": 3000, "cpuUnits": 0.1, "memoryMi": 512, "storageMi": 1024}}},
					"dns":      obj{"zoneId": "fixture-zone", "credentialsSecretRef": obj{"name": "fixture", "namespace": "cogni-production", "key": "token"}},
				},
				"status": obj{"activeLeaseGeneration": 1, "dns": obj{"target": blue}},
			}},
			"resources": obj{},
		},
	}
}
func xr(f obj) obj       { return at(f, "observed", "composite", "resource").(obj) }
func status(f obj) obj   { return xr(f)["status"].(obj) }
func observed(f obj) obj { return at(f, "observed", "resources").(obj) }

// Legacy fixtures use the actual emitted native spec, then attach the original
// logical owner and paid receipt. This does not mirror the recovery selector.
func child(t *testing.T, paidKey, target string, serving bool, logical ...string) obj {
	t.Helper()
	name := "akash-lease"
	if len(logical) != 0 {
		name = logical[0]
	}
	var g int
	if _, err := fmt.Sscanf(strings.Split(paidKey, ":")[3], "%d", &g); err != nil {
		t.Fatal(err)
	}
	seed := render(t, loadTemplate(t), fixture(g))
	native := r2Native(t, seed.leases["akash-lease"], name, "request-uid-"+name)
	var binding obj
	_ = json.Unmarshal([]byte(at(native, "resource", "spec", "forProvider", "payload", "body").(string)), &binding)
	binding["cogniKey"] = paidKey
	at(native, "resource", "spec", "forProvider", "payload").(obj)["body"] = jsonString(binding)
	endpoints := []string{target}
	if serving {
		endpoints = append(endpoints, host)
	}
	at(native, "resource").(obj)["status"] = obj{
		"requestDetails": obj{"method": "POST", "url": "http://akash-tx-actuator.cogni-candidate-a.svc.cluster.local:8080/v1/akash/observe", "body": jsonString(obj{"cogniKey": paidKey, "expectedSourceSha": strings.Repeat("b", 40), "publicHost": host})},
		"response":       obj{"statusCode": 200, "body": jsonString(obj{"found": true, "serving": serving, "resource": obj{"state": "active", "externalName": "lease-stable", "endpoints": endpoints}})}}
	return native
}
func dns(f obj, target string) {
	observed(f)["dns-record"] = obj{"resource": obj{"status": obj{"response": obj{"body": jsonString(obj{"result": []obj{{"type": "CNAME", "proxied": true, "content": target}}})}}}}
}
func loadTemplate(t *testing.T) *template.Template {
	t.Helper()
	raw, err := os.ReadFile(*compositionPath)
	if err != nil {
		t.Fatal(err)
	}
	var composition obj
	if err = yaml.Unmarshal(raw, &composition); err != nil {
		t.Fatal(err)
	}
	pipeline := at(composition, "spec", "pipeline").([]interface{})
	text := at(pipeline[0].(obj), "input", "inline", "template").(string)
	tmpl, err := template.New("composition").Funcs(sprig.TxtFuncMap()).Parse(text)
	if err != nil {
		t.Fatal(err)
	}
	return tmpl
}

type output struct {
	leases map[string]obj
	status obj
	dns    obj
}

func execute(t *testing.T, tmpl *template.Template, f obj) (output, error) {
	t.Helper()
	var b bytes.Buffer
	if err := tmpl.Execute(&b, f); err != nil {
		return output{}, err
	} // never accept partial output on failure
	out := output{leases: map[string]obj{}}
	decoder := yaml.NewDecoder(&b)
	for {
		var doc obj
		err := decoder.Decode(&doc)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		if len(doc) == 0 {
			continue
		}
		name, _ := at(doc, "metadata", "annotations", annotation).(string)
		if strings.HasPrefix(name, "akash-lease") {
			out.leases[name] = doc
		} else if name == "dns-record" {
			out.dns = doc
		} else if doc["kind"] == "XComputeWorkload" {
			out.status = doc["status"].(obj)
		}
	}
	return out, nil
}
func render(t *testing.T, tmpl *template.Template, f obj) output {
	t.Helper()
	out, err := execute(t, tmpl, f)
	if err != nil {
		t.Fatal(err)
	}
	return out
}
func names(out output) []string {
	a := []string{}
	for n := range out.leases {
		a = append(a, n)
	}
	sort.Strings(a)
	return a
}
func wantNames(t *testing.T, out output, want ...string) {
	t.Helper()
	if len(names(out)) != len(want) || (len(want) != 0 && !reflect.DeepEqual(names(out), want)) {
		t.Fatalf("lease children %v, want %v", names(out), want)
	}
}
func paid(out output, name string) string {
	var body obj
	_ = json.Unmarshal([]byte(at(out.leases[name], "spec", "forProvider", "payload", "body").(string)), &body)
	return body["cogniKey"].(string)
}
func dnsTarget(out output) interface{} {
	var body obj
	raw, _ := at(out.dns, "spec", "forProvider", "payload", "body").(string)
	_ = json.Unmarshal([]byte(raw), &body)
	return body["content"]
}

func TestPaidIdentityReplay(t *testing.T) {
	tmpl := loadTemplate(t)
	f := fixture(1)
	incumbent := child(t, key(1), blue, true)
	observed(f)["akash-lease"] = incumbent
	dns(f, blue)
	before := render(t, tmpl, f)
	wantNames(t, before, "akash-lease")
	// Merge rendered status like Crossplane: omitted fields do not erase old hints.
	for k, v := range before.status {
		status(f)[k] = v
	}
	xr(f)["spec"].(obj)["leaseGeneration"] = 0
	rollback := render(t, tmpl, f)
	wantNames(t, rollback, "akash-lease", "akash-lease-g0")
	if paid(rollback, "akash-lease") != key(1) || paid(rollback, "akash-lease-g0") != key(0) {
		t.Fatal("rollback changed paid identities")
	}
	observed(f)["akash-lease-g0"] = child(t, key(0), green, false, "akash-lease-g0")
	for k, v := range rollback.status {
		status(f)[k] = v
	}
	xr(f)["spec"].(obj)["leaseGeneration"] = 1
	restored := render(t, tmpl, f)
	wantNames(t, restored, "akash-lease")
	if paid(restored, "akash-lease") != key(1) {
		t.Fatal("restoration changed paid key")
	}
	// The logical annotation is Crossplane's identity lookup. No explicit name is
	// emitted to replace the observed Kubernetes Request (request-stable/request-uid).
	for _, out := range []output{before, restored} {
		if at(out.leases["akash-lease"], "metadata", "annotations", annotation) != "akash-lease" || at(out.leases["akash-lease"], "metadata", "name") != nil {
			t.Fatal("logical/Kubernetes identity selector changed")
		}
	}
	// A stale g0 hint survives status merging, yet observed-key selection stays stable.
	wantNames(t, render(t, tmpl, f), "akash-lease")
}

func TestObservedIdentityAndRecovery(t *testing.T) {
	tmpl := loadTemplate(t)
	for _, name := range []string{"akash-lease", "akash-lease-g1", "akash-lease-g0"} {
		for _, hint := range []int{-1, 0, 1, 8} {
			t.Run(fmt.Sprintf("%s/hint%d", name, hint), func(t *testing.T) {
				f := fixture(1)
				if hint >= 0 {
					status(f)["leaseRequestGeneration"] = hint
				}
				observed(f)[name] = child(t, key(1), blue, true, name)
				out := render(t, tmpl, f)
				wantNames(t, out, name)
				if paid(out, name) != key(1) {
					t.Fatal("paid key changed")
				}
			})
		}
	}
	for attempt := 1; attempt <= 3; attempt++ {
		t.Run(fmt.Sprintf("recovery%d", attempt), func(t *testing.T) {
			f := fixture(1)
			k := fmt.Sprintf("%s:recover:%d", key(1), attempt)
			observed(f)["akash-lease"] = child(t, k, blue, true, "akash-lease")
			status(f)["recovery"] = obj{"leaseGeneration": 1, "count": attempt}
			out := render(t, tmpl, f)
			wantNames(t, out, "akash-lease")
			if paid(out, "akash-lease") != k {
				t.Fatal("recovery receipt rewritten")
			}
		})
	}
	familyBoundary := fixture(1)
	status(familyBoundary)["activeLeaseGeneration"] = 10
	observed(familyBoundary)["akash-lease"] = child(t, key(10), blue, true, "akash-lease")
	boundary := render(t, tmpl, familyBoundary)
	wantNames(t, boundary, "akash-lease", "akash-lease-g1")
	if paid(boundary, "akash-lease") != key(10) || paid(boundary, "akash-lease-g1") != key(1) {
		t.Fatal("generation-prefix collision")
	}
	// Kubernetes may serialize an unset deletion timestamp as null.
	notDeleting := fixture(1)
	observed(notDeleting)["akash-lease"] = child(t, key(1), blue, true, "akash-lease")
	at(observed(notDeleting)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = nil
	wantNames(t, render(t, tmpl, notDeleting), "akash-lease")
	// An empty observation is bootstrap, not a paid receipt.
	f := fixture(2)
	wantNames(t, render(t, tmpl, f), "akash-lease")
}

func TestUnsafeObservationsFailWholeRender(t *testing.T) {
	tmpl := loadTemplate(t)
	cases := map[string]func(obj){
		"duplicate exact": func(f obj) { observed(f)["akash-lease-g1"] = child(t, key(1), blue, true, "akash-lease-g1") },
		"duplicate family": func(f obj) {
			observed(f)["akash-lease-g1"] = child(t, key(1)+":recover:1", blue, true, "akash-lease-g1")
		},
		"deleting desired": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
		},
		"deleting duplicate": func(f obj) {
			c := child(t, key(1), blue, true)
			at(c, "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
			observed(f)["akash-lease-g1"] = c
		},
		"missing details": func(f obj) {
			delete(at(observed(f)["akash-lease"].(obj), "resource", "status").(obj), "requestDetails")
		},
		"malformed JSON": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "status", "requestDetails").(obj)["body"] = "{"
		},
		"non-object JSON": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "status", "requestDetails").(obj)["body"] = "[]"
		},
		"missing key": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "status", "requestDetails").(obj)["body"] = "{}"
		},
		"non-string key": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "status", "requestDetails").(obj)["body"] = `{"cogniKey":1}`
		},
		"stale recovery status":   func(f obj) { status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 1} },
		"missing recovery status": func(f obj) { observed(f)["akash-lease"] = child(t, key(1)+":recover:2", blue, true, "akash-lease") },
		"wrong recovery generation": func(f obj) {
			observed(f)["akash-lease"] = child(t, key(1)+":recover:2", blue, true, "akash-lease")
			status(f)["recovery"] = obj{"leaseGeneration": 0, "count": 2}
		},
		"active duplicate": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			observed(f)["akash-lease-g1"] = child(t, key(1), blue, true, "akash-lease-g1")
		},
		"active deleting": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			at(observed(f)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
		},
		"occupied new name": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			observed(f)["akash-lease-g2"] = child(t, key(0), blue, true, "akash-lease-g2")
		},
	}
	cases["leading-zero generation"] = func(f obj) {
		observed(f)["akash-lease"] = child(t, strings.TrimSuffix(key(1), "1")+"01", blue, true, "akash-lease")
	}
	cases["recovery count behind"] = func(f obj) {
		observed(f)["akash-lease"] = child(t, key(1)+":recover:2", blue, true, "akash-lease")
		status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 1}
	}
	cases["recovery count ahead"] = func(f obj) {
		observed(f)["akash-lease"] = child(t, key(1)+":recover:1", blue, true, "akash-lease")
		status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 2}
	}
	for _, suffix := range []string{":recover:0", ":recover:4", ":recover:01", ":recover:1:extra", ":recover:", ":recover:-1"} {
		suffix := suffix
		cases["malformed "+suffix] = func(f obj) { observed(f)["akash-lease"] = child(t, key(1)+suffix, blue, true, "akash-lease") }
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := fixture(1)
			observed(f)["akash-lease"] = child(t, key(1), blue, true, "akash-lease")
			mutate(f)
			out, err := execute(t, tmpl, f)
			if err == nil {
				t.Fatalf("unsafe observation succeeded: %v", names(out))
			}
			if out.leases != nil {
				t.Fatal("partial desired output escaped failure")
			}
		})
	}
}

func TestReplacementProvesThenCutsOverThenAllowsNativeDelete(t *testing.T) {
	tmpl := loadTemplate(t)
	f := fixture(2)
	observed(f)["akash-lease"] = child(t, key(1), blue, true, "akash-lease")
	dns(f, blue)
	initial := render(t, tmpl, f)
	wantNames(t, initial, "akash-lease", "akash-lease-g2")
	if dnsTarget(initial) != blue || initial.status["activeLeaseGeneration"] != 1 {
		t.Fatal("cut over before candidate exists")
	}
	observed(f)["akash-lease-g2"] = child(t, key(2), green, false, "akash-lease-g2")
	booting := render(t, tmpl, f)
	wantNames(t, booting, "akash-lease", "akash-lease-g2")
	if dnsTarget(booting) != blue {
		t.Fatal("traffic before proof")
	}
	// A serving result without the provider admitting the host is insufficient.
	c := child(t, key(2), green, false, "akash-lease-g2")
	at(c, "resource", "status", "response").(obj)["body"] = jsonString(obj{"found": true, "serving": true, "resource": obj{"state": "active", "externalName": "lease-green", "endpoints": []string{green}}})
	observed(f)["akash-lease-g2"] = c
	if dnsTarget(render(t, tmpl, f)) != blue {
		t.Fatal("unadmitted host moved traffic")
	}
	observed(f)["akash-lease-g2"] = child(t, key(2), green, true, "akash-lease-g2")
	proven := render(t, tmpl, f)
	wantNames(t, proven, "akash-lease", "akash-lease-g2")
	if dnsTarget(proven) != green || proven.status["activeLeaseGeneration"] != 1 {
		t.Fatal("incumbent released before live DNS read-back")
	}
	dns(f, green)
	cutover := render(t, tmpl, f)
	wantNames(t, cutover, "akash-lease", "akash-lease-g2")
	if cutover.status["activeLeaseGeneration"] != 2 {
		t.Fatal("live cutover did not latch")
	}
	for k, v := range cutover.status {
		status(f)[k] = v
	}
	after := render(t, tmpl, f)
	wantNames(t, after, "akash-lease-g2")
	// Omission is Crossplane's native GC trigger, retaining the original paid REMOVE key.
	if paid(cutover, "akash-lease") != key(1) {
		t.Fatal("wrong key for native deletion")
	}
	mappings := at(cutover.leases["akash-lease"], "spec", "forProvider", "mappings").([]interface{})
	removeFound := false
	for _, raw := range mappings {
		m := raw.(obj)
		if m["action"] == "REMOVE" {
			removeFound = true
			if !strings.Contains(m["url"].(string), "/v1/akash/delete") || !strings.Contains(m["body"].(string), ".payload.body.cogniKey") {
				t.Fatal("native REMOVE contract changed")
			}
		}
	}
	if !removeFound {
		t.Fatal("native REMOVE missing")
	}
}

// Append to the existing fixture; UNEXECUTED design test code.
// Uses its obj/at/xr/status/observed/render/paid/names/loadTemplate helpers.
func r2Copy(t *testing.T, x obj) obj {
	t.Helper()
	var y obj
	if err := json.Unmarshal([]byte(jsonString(x)), &y); err != nil {
		t.Fatal(err)
	}
	return y
}
func r2Merge(f obj, o output) {
	for k, v := range o.status {
		status(f)[k] = v
	}
}
func r2Native(t *testing.T, d obj, logical, uid string) obj {
	t.Helper()
	c := r2Copy(t, d)
	c["metadata"] = obj{"name": "native-" + uid, "namespace": "cogni-candidate-a", "uid": uid,
		"annotations": obj{"crossplane.io/composition-resource-name": logical},
		"ownerReferences": []obj{{"apiVersion": "compute.cogni.io/v1alpha1", "kind": "XComputeWorkload",
			"name": node, "uid": "xr-uid", "controller": true}}}
	return obj{"resource": c}
}
func r2Stamp(c obj, k, state string, serving, direct bool) {
	sha := strings.Repeat("b", 40)
	resource := obj{"state": state, "externalName": "handle-" + k, "endpoints": []string{blue, host}}
	body := obj{"found": true, "serving": serving, "resource": resource}
	wire := obj{"cogniKey": k, "expectedSourceSha": sha, "publicHost": host}
	action := "observe"
	if direct {
		body = resource
		body["replayed"] = true
		body["recovered"] = false
		// Actual CREATE request body; do not invent an OBSERVE requestDetails shape.
		_ = json.Unmarshal([]byte(at(c, "resource", "spec", "forProvider", "payload", "body").(string)), &wire)
		action = "create"
	}
	at(c, "resource").(obj)["status"] = obj{
		"requestDetails": obj{"method": "POST", "url": "http://akash-tx-actuator.cogni-candidate-a.svc.cluster.local:8080/v1/akash/" + action, "body": jsonString(wire)},
		"response":       obj{"statusCode": 200, "body": jsonString(body)}}
}
func r2Check(t *testing.T, o output, n int) string {
	t.Helper()
	name := fmt.Sprintf("akash-lease-g1-recover-%d", n)
	if _, ok := o.leases[name]; !ok {
		t.Fatalf("missing distinct native successor %s; emitted %v", name, names(o))
	}
	if paid(o, name) != fmt.Sprintf("%s:recover:%d", key(1), n) ||
		fmt.Sprint(at(o.status, "recovery", "count")) != fmt.Sprint(n) {
		t.Fatal("selection drift", names(o), o.status)
	}
	if at(o.leases[name], "metadata", "name") != nil {
		t.Fatal("forced physical name")
	}
	create := false
	for _, raw := range at(o.leases[name], "spec", "forProvider", "mappings").([]interface{}) {
		m := raw.(obj)
		if m["action"] == "CREATE" {
			create = m["method"] == "POST" && strings.Contains(m["url"].(string), "/v1/akash/create") &&
				strings.Contains(m["body"].(string), ".payload.body.cogniKey")
		}
	}
	if !create {
		t.Fatal("not native CREATE intent")
	}
	return name
}
func TestR2DistinctRecoveryAndPropagation(t *testing.T) {
	for _, order := range []string{"status-first", "child-first"} {
		t.Run(order, func(t *testing.T) {
			tm := loadTemplate(t)
			f := fixture(1)
			xr(f)["apiVersion"] = "compute.cogni.io/v1alpha1"
			xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace"}
			seed := render(t, tm, f)
			oldName := "akash-lease"
			oldKey := key(1)
			old := r2Native(t, seed.leases[oldName], oldName, "base")
			r2Stamp(old, oldKey, "closed", false, true) // Producer-valid settled CREATE replay.
			observed(f)[oldName] = old
			for n := 1; n <= 3; n++ {
				original := jsonString(at(old, "resource", "spec"))
				first := render(t, tm, f)
				name := r2Check(t, first, n)
				if at(first.status, "bootEpoch", "mintedAt") != nil || at(first.status, "bootEpoch", "at") == at(xr(f), "metadata", "creationTimestamp") {
					t.Fatal("fresh recovery inherited predecessor clock", first.status)
				}
				if _, ok := first.leases[oldName]; !ok {
					t.Fatal("closure omitted before selection durable")
				}
				if paid(first, oldName) != oldKey {
					t.Fatal("retired Request retargeted")
				}
				for i := 0; i < 3; i++ {
					r2Check(t, render(t, tm, f), n)
				} // Neither apply nor status yet.
				current := r2Native(t, first.leases[name], name, fmt.Sprintf("recovery%d", n))
				if order == "status-first" {
					r2Merge(f, first)
					for i := 0; i < 3; i++ {
						r2Check(t, render(t, tm, f), n)
					} // Legitimate missing child.
					observed(f)[name] = current
				} else {
					observed(f)[name] = current // Native refs/apply happened; XR status patch lost.
					adjacent := render(t, tm, f)
					r2Check(t, adjacent, n)
					r2Merge(f, adjacent)
				}
				for i := 0; i < 3; i++ {
					o := render(t, tm, f)
					r2Check(t, o, n)
					wantNames(t, o, name)
					r2Merge(f, o)
				} // Old closed child remains in observed: response replay cannot advance.
				if jsonString(at(old, "resource", "spec")) != original {
					t.Fatal("old cleanup identity changed")
				}
				// Apply desired omission and later native finalization as separate input frames.
				delete(observed(f), oldName)
				for _, state := range []string{"pending", "active", "unknown", "active"} {
					r2Stamp(current, fmt.Sprintf("%s:recover:%d", key(1), n), state, false, false)
					o := render(t, tm, f)
					r2Check(t, o, n)
					wantNames(t, o, name)
					r2Merge(f, o)
				}
				oldName = name
				oldKey = fmt.Sprintf("%s:recover:%d", key(1), n)
				old = current
				r2Stamp(old, oldKey, "closed", false, true)
			}
			terminal := render(t, tm, f)
			wantNames(t, terminal, oldName) // Persist terminal proof BEFORE omission.
			if at(terminal.status, "failure", "reason") != "RecoveryLimitExceeded" {
				t.Fatal(terminal.status)
			}
			r2Merge(f, terminal)
			omitted := render(t, tm, f)
			wantNames(t, omitted)
			// Crash after GC/ref persistence and before this pass's XR status patch.
			delete(observed(f), oldName)
			f = r2Copy(t, f)
			tm = loadTemplate(t) // Restart with durable earlier status only.
			for i := 0; i < 5; i++ {
				o := render(t, tm, f)
				wantNames(t, o)
				if at(o.status, "failure", "reason") != "RecoveryLimitExceeded" ||
					fmt.Sprint(at(o.status, "recovery", "count")) != "3" {
					t.Fatal("resurrected spent attempt", o.status)
				}
				r2Merge(f, o)
			}
		})
	}
}
func TestR2HoldClosedSurvivesOmission(t *testing.T) {
	tm := loadTemplate(t)
	f := fixture(1)
	xr(f)["apiVersion"] = "compute.cogni.io/v1alpha1"
	xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Hold"}
	seed := render(t, tm, f)
	c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "base")
	r2Stamp(c, key(1), "closed", false, true)
	observed(f)["akash-lease"] = c
	parked := render(t, tm, f)
	wantNames(t, parked, "akash-lease")
	if at(parked.status, "failure", "reason") != "LeaseClosed" {
		t.Fatal(parked.status)
	}
	r2Merge(f, parked)
	wantNames(t, render(t, tm, f))
	delete(observed(f), "akash-lease") // Native child removed and ref omitted.
	for i := 0; i < 5; i++ {
		o := render(t, loadTemplate(t), f)
		wantNames(t, o)
		if at(o.status, "failure", "reason") != "LeaseClosed" || at(o.status, "recovery", "count") != nil {
			t.Fatal("Hold recreated/advanced", o.status)
		}
		r2Merge(f, o)
	}
}
func TestR2SameShaServiceDoesNotCrossPaidAttempt(t *testing.T) {
	for _, servedSuccessor := range []bool{false, true} {
		t.Run(fmt.Sprint(servedSuccessor), func(t *testing.T) {
			tm := loadTemplate(t)
			f := fixture(1)
			xr(f)["apiVersion"] = "compute.cogni.io/v1alpha1"
			xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace", "onDeadline": "Close", "bootDeadlineSeconds": 60}
			sha := strings.Repeat("b", 40)
			b := sha + ":1"
			seed := render(t, tm, f)
			bundle := xr(f)["spec"].(obj)["bundle"].(obj)
			status(f)["observedBundle"] = obj{"ref": bundle["ref"], "source": bundle["source"]}
			status(f)["bootEpoch"] = obj{"key": b + ":served", "at": "2000-01-01T00:00:00Z", "mintedAt": "2000-01-01T00:00:00Z"}
			c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "base")
			r2Stamp(c, key(1), "closed", false, true)
			observed(f)["akash-lease"] = c
			first := render(t, tm, f)
			name := r2Check(t, first, 1)
			r2Merge(f, first)
			if at(first.status, "bootEpoch", "mintedAt") != nil || first.status["serving"] == true ||
				at(first.status, "bootEpoch", "key") != b+":recover:1:unserved" {
				t.Fatal("predecessor proof leaked")
			}
			k := key(1) + ":recover:1"
			current := r2Native(t, first.leases[name], name, "successor")
			observed(f)[name] = current
			// Keep stale predecessor observed through successor initialization.
			r2Stamp(current, k, "pending", false, false)
			pending := render(t, tm, f)
			r2Merge(f, pending)
			if at(pending.status, "bootEpoch", "mintedAt") == nil {
				t.Fatal("own allocation failed to start clock")
			}
			if servedSuccessor {
				r2Stamp(current, k, "active", true, false)
				proved := render(t, tm, f)
				r2Merge(f, proved)
				if at(proved.status, "bootEpoch", "key") != b+":recover:1:served" {
					t.Fatal("service not bound")
				}
			}
			status(f)["bootEpoch"].(obj)["mintedAt"] = "2000-01-01T00:00:00Z"
			r2Stamp(current, k, "active", false, false)
			o := render(t, tm, f)
			if servedSuccessor {
				wantNames(t, o, name)
				if at(o.status, "failure", "reason") == "BootDeadlineClosed" {
					t.Fatal("same attempt killed on negative probe")
				}
			} else {
				wantNames(t, o, name) // First pass stores retirement before GC.
				if at(o.status, "failure", "reason") != "BootDeadlineClosed" {
					t.Fatal("old SHA disabled deadline", o.status)
				}
				r2Merge(f, o)
				wantNames(t, render(t, tm, f))
				delete(observed(f), name)
				delete(observed(f), "akash-lease")
				for i := 0; i < 4; i++ {
					parked := render(t, tm, f)
					wantNames(t, parked)
					r2Merge(f, parked)
					if fmt.Sprint(at(parked.status, "recovery", "count")) != "1" {
						t.Fatal("budget invented closure/ordinal")
					}
				}
			}
		})
	}
}

// These tests assert desired native intent only. CI executes them; native CREATE,
// UID continuity, skip-REMOVE/actual REMOVE and receipt/cost settlement need their
// separate owners and live gates. No assertion below certifies those effects.
func r2ClosedBase(t *testing.T, policy string, direct bool) (obj, obj) {
	t.Helper()
	f := fixture(1)
	xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": policy}
	seed := render(t, loadTemplate(t), f)
	c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "base")
	r2Stamp(c, key(1), "closed", false, direct)
	observed(f)["akash-lease"] = c
	return f, c
}
func r2Mapping(t *testing.T, d obj, action string) obj {
	t.Helper()
	for _, raw := range at(d, "spec", "forProvider", "mappings").([]interface{}) {
		m := raw.(obj)
		if m["action"] == action {
			return m
		}
	}
	t.Fatalf("missing %s mapping", action)
	return nil
}
func r2Cleanup(t *testing.T, d obj, k string) {
	t.Helper()
	var payload obj
	if err := json.Unmarshal([]byte(at(d, "spec", "forProvider", "payload", "body").(string)), &payload); err != nil {
		t.Fatal(err)
	}
	if payload["cogniKey"] != k {
		t.Fatal("cleanup retargeted original paid key", payload)
	}
	for _, action := range []string{"UPDATE", "REMOVE"} {
		m := r2Mapping(t, d, action)
		if m["method"] != "POST" || !strings.Contains(m["body"].(string), "cogniKey: .payload.body.cogniKey") ||
			!strings.Contains(m["body"].(string), "externalName: (.response.body.resource.externalName // .response.body.externalName)") {
			t.Fatal("cleanup must use this Request's own key and wrapped/direct response (or provider cache)", m)
		}
	}
	if !strings.Contains(r2Mapping(t, d, "REMOVE")["url"].(string), "/v1/akash/delete") {
		t.Fatal("REMOVE owner changed")
	}
	if !strings.Contains(at(d, "spec", "forProvider", "isRemovedCheck", "logic").(string), ".response.body.state") {
		t.Fatal("direct terminal replay cannot finalize")
	}
}
func r2WantFailure(t *testing.T, tm *template.Template, f obj) {
	t.Helper()
	out, err := execute(t, tm, f)
	if err == nil || out.leases != nil {
		t.Fatal("unsafe frame escaped whole-render failure", names(out), err)
	}
}
func r2SetSha(f obj, sha string) { xr(f)["spec"].(obj)["bundle"].(obj)["source"].(obj)["sha"] = sha }

func TestR2EmittedPredecessorSpecAndOwnCleanup(t *testing.T) {
	for _, direct := range []bool{false, true} {
		t.Run(fmt.Sprint(direct), func(t *testing.T) {
			tm := loadTemplate(t)
			f, c := r2ClosedBase(t, "Replace", direct)
			original := r2Copy(t, at(c, "resource", "spec").(obj))
			first := render(t, tm, f)
			n := r2Check(t, first, 1)
			wantNames(t, first, "akash-lease", n)
			r2Cleanup(t, first.leases["akash-lease"], key(1))
			r2Cleanup(t, first.leases[n], key(1)+":recover:1")
			// Inspect EMITTED old spec. Current payload changes cannot replace its old
			// services, identity, headers or original CREATE/OBSERVE mappings.
			emitted := at(first.leases["akash-lease"], "spec").(obj)
			for _, field := range []string{"payload", "headers", "waitTimeout"} {
				if jsonString(at(emitted, "forProvider", field)) != jsonString(at(original, "forProvider", field)) {
					t.Fatal("old spec changed", field)
				}
			}
			for _, action := range []string{"CREATE", "OBSERVE"} {
				if jsonString(r2Mapping(t, first.leases["akash-lease"], action)) != jsonString(r2Mapping(t, at(c, "resource").(obj), action)) {
					t.Fatal("old mapping changed", action)
				}
			}
			r2Merge(f, first)
			// Delayed predecessor GC may be deleting: it is already positively closed,
			// and its successor selection is durable. It cannot be selected again.
			at(c, "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
			for i := 0; i < 4; i++ {
				o := render(t, tm, f)
				wantNames(t, o, n)
				r2Check(t, o, 1)
			}
			delete(observed(f), "akash-lease")
			for i := 0; i < 3; i++ {
				wantNames(t, render(t, tm, f), n)
			}
		})
	}
}

func TestR2TerminalParksSurviveRestartShaAndDelayedGC(t *testing.T) {
	for _, mode := range []string{"default", "Hold", "max3", "budget"} {
		t.Run(mode, func(t *testing.T) {
			tm := loadTemplate(t)
			f, c := r2ClosedBase(t, "Hold", true)
			selected := "akash-lease"
			reason := "LeaseClosed"
			if mode == "default" {
				delete(xr(f)["spec"].(obj), "bootPolicy")
			}
			if mode == "max3" {
				// A legacy aligned recovery keeps its original native logical name.
				k := key(1) + ":recover:3"
				var binding obj
				_ = json.Unmarshal([]byte(at(c, "resource", "spec", "forProvider", "payload", "body").(string)), &binding)
				binding["cogniKey"] = k
				at(c, "resource", "spec", "forProvider", "payload").(obj)["body"] = jsonString(binding)
				r2Stamp(c, k, "closed", false, true)
				status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 3, "key": k, "maxAttempts": 3}
				xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace"}
				reason = "RecoveryLimitExceeded"
			}
			if mode == "budget" {
				xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace", "onDeadline": "Close", "bootDeadlineSeconds": 60}
				r2Stamp(c, key(1), "active", false, false)
				status(f)["bootEpoch"] = obj{"key": strings.Repeat("b", 40) + ":1:unserved", "at": "2000-01-01T00:00:00Z", "mintedAt": "2000-01-01T00:00:00Z"}
				reason = "BootDeadlineClosed"
			}
			first := render(t, tm, f)
			wantNames(t, first, selected) // Neither refs nor status persisted: retain again.
			wantNames(t, render(t, tm, f), selected)
			if at(first.status, "failure", "reason") != reason {
				t.Fatal(first.status)
			}
			if mode == "budget" {
				message := at(first.status, "failure", "message").(string)
				if !strings.Contains(message, "retirement requested") || strings.Contains(message, "was closed") || at(first.status, "resource", "state") == "closed" {
					t.Fatal("timer fabricated closure", first.status)
				}
			}
			r2Merge(f, first) // Earlier status survives subsequent GC/ref/apply crash.
			wantNames(t, render(t, tm, f))
			at(c, "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
			wantNames(t, render(t, tm, f)) // Already retired terminal child may finish GC.
			delete(observed(f), selected)
			f = r2Copy(t, f)
			for i := 0; i < 6; i++ {
				if i == 2 {
					r2SetSha(f, strings.Repeat("d", 40))
				}
				o := render(t, loadTemplate(t), f)
				wantNames(t, o)
				if at(o.status, "failure", "reason") != reason || at(o.status, "resource", "id") != at(first.status, "resource", "id") || at(o.status, "bootEpoch", "key") != at(first.status, "bootEpoch", "key") {
					t.Fatal("park lost its complete bound evidence", o.status)
				}
				r2Merge(f, o)
			}
			// A reason alone, wrong tuple, absent handle or erased budget clock cannot
			// substitute for the earlier bound evidence after the native child is gone.
			for _, field := range []string{"boot-key", "handle", "recovery", "clock"} {
				if field == "clock" && mode != "budget" {
					continue
				}
				if field == "recovery" && mode != "max3" {
					continue
				}
				bad := r2Copy(t, f)
				switch field {
				case "boot-key":
					status(bad)["bootEpoch"].(obj)["key"] = strings.Repeat("b", 40) + ":1:recover:2:unserved"
				case "handle":
					delete(status(bad)["resource"].(obj), "id")
				case "recovery":
					status(bad)["recovery"].(obj)["key"] = key(1) + ":recover:2"
				case "clock":
					status(bad)["bootEpoch"].(obj)["mintedAt"] = nil
				}
				r2WantFailure(t, tm, bad)
			}
		})
	}
}

func TestR2CanonicalClockLegacyAndFreshServing(t *testing.T) {
	for _, qualifier := range []string{"", ":unserved", ":served"} {
		for _, historical := range []bool{false, true} {
			t.Run(fmt.Sprintf("%q/history%v", qualifier, historical), func(t *testing.T) {
				tm := loadTemplate(t)
				f := fixture(1)
				xr(f)["spec"].(obj)["bootPolicy"] = obj{"onDeadline": "Close", "bootDeadlineSeconds": 60}
				seed := render(t, tm, f)
				c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "clock")
				r2Stamp(c, key(1), "active", false, false)
				observed(f)["akash-lease"] = c
				b := strings.Repeat("b", 40) + ":1"
				status(f)["bootEpoch"] = obj{"key": b + qualifier, "at": "2000-01-01T00:00:00Z", "mintedAt": "2000-01-01T00:00:00Z"}
				if historical {
					bundle := xr(f)["spec"].(obj)["bundle"].(obj)
					status(f)["observedBundle"] = obj{"ref": bundle["ref"], "source": bundle["source"]}
				}
				if qualifier == ":served" && !historical {
					r2WantFailure(t, tm, f)
					return
				}
				o := render(t, tm, f)
				protected := historical && qualifier != ":unserved"
				if (at(o.status, "failure", "reason") == "BootDeadlineClosed") == protected {
					t.Fatal("history scope changed", o.status)
				}
				if at(o.status, "bootEpoch", "mintedAt") != "2000-01-01T00:00:00Z" || o.status["serving"] == true || o.status["phase"] == "Ready" {
					t.Fatal("qualifier reset clock or manufactured Ready", o.status)
				}
				// A positive exact-key/exact-SHA OBSERVE upgrades to served without
				// moving either clock. It still needs fresh proof on later probes.
				if protected {
					r2Stamp(c, key(1), "active", true, false)
					proved := render(t, tm, f)
					if at(proved.status, "bootEpoch", "key") != b+":served" || at(proved.status, "bootEpoch", "mintedAt") != "2000-01-01T00:00:00Z" || proved.status["phase"] != "Ready" {
						t.Fatal(proved.status)
					}
					r2Merge(f, proved)
					r2Stamp(c, key(1), "active", false, false)
					negative := render(t, tm, f)
					if negative.status["phase"] == "Ready" || at(negative.status, "failure", "reason") == "BootDeadlineClosed" {
						t.Fatal("negative probe destroyed served history", negative.status)
					}
				}
			})
		}
	}
}

func TestR2NoAdvanceWithoutSuccessfulCurrentClosure(t *testing.T) {
	tm := loadTemplate(t)
	for _, kind := range []string{"pending", "active", "unknown", "missing", "no-response", "refusal", "server-error", "closed-no-status", "closed-no-handle", "create-echo", "stale-sha", "ambiguous", "closed-ambiguous"} {
		t.Run(kind, func(t *testing.T) {
			f := fixture(1)
			xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace", "onDeadline": "Close", "bootDeadlineSeconds": 60}
			seed := render(t, tm, f)
			c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "noadvance")
			r2Stamp(c, key(1), "unknown", false, false)
			observed(f)["akash-lease"] = c
			switch kind {
			case "pending", "active", "unknown":
				r2Stamp(c, key(1), kind, false, false)
			case "missing":
				at(c, "resource", "status", "response").(obj)["body"] = `{"found":false}`
			case "no-response":
				delete(at(c, "resource").(obj), "status")
			case "refusal", "server-error":
				code := 422
				if kind == "server-error" {
					code = 503
				}
				at(c, "resource", "status").(obj)["response"] = obj{"statusCode": code, "body": `{"code":"ledger_unavailable","message":"unproven"}`}
			case "closed-no-status":
				r2Stamp(c, key(1), "closed", false, false)
				delete(at(c, "resource", "status", "response").(obj), "statusCode")
			case "closed-no-handle":
				at(c, "resource", "status", "response").(obj)["body"] = `{"found":true,"resource":{"state":"closed","externalName":"","endpoints":[]}}`
			case "create-echo":
				r2Stamp(c, key(1), "active", true, true)
			case "stale-sha":
				r2Stamp(c, key(1), "active", true, false)
				at(c, "resource", "status", "requestDetails").(obj)["body"] = jsonString(obj{"cogniKey": key(1), "expectedSourceSha": strings.Repeat("a", 40), "publicHost": host})
			case "ambiguous", "closed-ambiguous":
				if kind == "closed-ambiguous" {
					r2Stamp(c, key(1), "closed", false, true)
				}
				at(c, "resource", "metadata", "annotations").(obj)["crossplane.io/external-create-pending"] = "2026-10-30T00:00:00Z"
				at(c, "resource", "status").(obj)["conditions"] = []obj{{"message": "cannot determine creation result"}}
			}
			for i := 0; i < 3; i++ {
				o := render(t, tm, f)
				wantNames(t, o, "akash-lease")
				if paid(o, "akash-lease") != key(1) || at(o.status, "recovery", "count") != nil || o.status["serving"] == true || o.status["phase"] == "Ready" {
					t.Fatal("non-proof allocated or served", kind, o.status)
				}
				if kind == "missing" || kind == "no-response" || kind == "refusal" || kind == "server-error" || kind == "closed-no-status" || kind == "closed-no-handle" {
					if at(o.status, "bootEpoch", "mintedAt") != nil {
						t.Fatal("unproven allocation started paid clock", kind, o.status)
					}
				}
				if (kind == "ambiguous" || kind == "closed-ambiguous") && at(o.leases["akash-lease"], "metadata", "annotations", "crossplane.io/external-create-succeeded") != nil {
					t.Fatal("ambiguity bypass")
				}
				r2Merge(f, o)
			}
		})
	}
}

func TestR2CombinedOutgoingClosedCandidateAndFreshSuccessor(t *testing.T) {
	tm := loadTemplate(t)
	oldFixture := fixture(1)
	oldSeed := render(t, tm, oldFixture)
	incumbent := r2Native(t, oldSeed.leases["akash-lease"], "akash-lease-g1", "incumbent")
	r2Stamp(incumbent, key(1), "active", true, false)
	f := fixture(2)
	status(f)["leaseRequestGeneration"] = 1
	xr(f)["spec"].(obj)["bootPolicy"] = obj{"onGiveUp": "Replace"}
	observed(f)["akash-lease-g1"] = incumbent
	seed := render(t, tm, f)
	predecessor := r2Native(t, seed.leases["akash-lease-g2"], "akash-lease-g2", "candidate-base")
	r2Stamp(predecessor, key(2), "closed", false, true)
	observed(f)["akash-lease-g2"] = predecessor
	first := render(t, tm, f)
	name := "akash-lease-g2-recover-1"
	wantNames(t, first, "akash-lease-g1", "akash-lease-g2", name)
	// Three Requests, at most two live allocation intents: the retained outgoing
	// lease plus the new successor. The staged candidate is positively CLOSED.
	if at(predecessor, "resource", "status", "response", "statusCode") != 200 ||
		!strings.Contains(at(predecessor, "resource", "status", "response", "body").(string), `"state":"closed"`) ||
		paid(first, "akash-lease-g1") != key(1) || paid(first, "akash-lease-g2") != key(2) || paid(first, name) != key(2)+":recover:1" {
		t.Fatal("live allocation budget/identities changed", first.status)
	}
	if first.status["activeLeaseGeneration"] != 1 || dnsTarget(first) != blue {
		t.Fatal("fresh successor took traffic", first.status)
	}
	for _, pair := range []struct{ name, k string }{{"akash-lease-g1", key(1)}, {"akash-lease-g2", key(2)}, {name, key(2) + ":recover:1"}} {
		r2Cleanup(t, first.leases[pair.name], pair.k)
	}
	r2Merge(f, first)
	current := r2Native(t, first.leases[name], name, "candidate-recovery")
	observed(f)[name] = current
	for i := 0; i < 3; i++ {
		o := render(t, tm, f)
		wantNames(t, o, "akash-lease-g1", name)
		if o.status["activeLeaseGeneration"] != 1 || dnsTarget(o) != blue {
			t.Fatal("incumbent lost before proof")
		}
		r2Merge(f, o)
	}
	at(predecessor, "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
	wantNames(t, render(t, tm, f), "akash-lease-g1", name)
	r2Stamp(current, key(2)+":recover:1", "active", true, false)
	var body obj
	_ = json.Unmarshal([]byte(at(current, "resource", "status", "response", "body").(string)), &body)
	body["resource"].(obj)["endpoints"] = []string{green, host}
	at(current, "resource", "status", "response").(obj)["body"] = jsonString(body)
	proved := render(t, tm, f)
	wantNames(t, proved, "akash-lease-g1", name)
	if proved.status["activeLeaseGeneration"] != 1 || dnsTarget(proved) != green {
		t.Fatal("edge intent confused with proof", proved.status)
	}
	dns(f, green)
	cutover := render(t, tm, f)
	r2Merge(f, cutover)
	if cutover.status["activeLeaseGeneration"] != 2 {
		t.Fatal("positive DNS readback did not latch")
	}
	wantNames(t, render(t, tm, f), name)
}

func TestR2UnsafeNativeBindingsAndPropagation(t *testing.T) {
	tm := loadTemplate(t)
	cases := map[string]func(obj, obj){
		"unqualified family member": func(f obj, c obj) {
			other := r2Copy(t, c)
			at(other, "resource", "metadata", "annotations").(obj)["crossplane.io/composition-resource-name"] = "paid-alias"
			observed(f)["paid-alias"] = other
		},
		"wrong native group": func(_ obj, c obj) { at(c, "resource").(obj)["apiVersion"] = "http.crossplane.io/v1alpha2" },
		"wrong namespace":    func(_ obj, c obj) { at(c, "resource", "metadata").(obj)["namespace"] = "cogni-production" },
		"missing native uid": func(_ obj, c obj) { delete(at(c, "resource", "metadata").(obj), "uid") },
		"wrong logical annotation": func(_ obj, c obj) {
			at(c, "resource", "metadata", "annotations").(obj)["crossplane.io/composition-resource-name"] = "akash-lease-g9"
		},
		"wrong controller": func(_ obj, c obj) {
			at(c, "resource", "metadata").(obj)["ownerReferences"] = []obj{{"apiVersion": "compute.cogni.io/v1alpha1", "kind": "XComputeWorkload", "name": node, "uid": "other-xr", "controller": true}}
		},
		"no controller": func(_ obj, c obj) { at(c, "resource", "metadata").(obj)["ownerReferences"] = []obj{} },
		"two controllers": func(_ obj, c obj) {
			owner := obj{"apiVersion": "compute.cogni.io/v1alpha1", "kind": "XComputeWorkload", "name": node, "uid": "xr-uid", "controller": true}
			at(c, "resource", "metadata").(obj)["ownerReferences"] = []obj{owner, owner}
		},
		"malformed payload": func(_ obj, c obj) { at(c, "resource", "spec", "forProvider", "payload").(obj)["body"] = "null" },
		"recorded cleanup handle conflict": func(_ obj, c obj) {
			at(c, "resource", "status", "requestDetails").(obj)["body"] = jsonString(obj{"cogniKey": key(1), "externalName": "foreign-handle"})
		},
		"spec receipt mismatch": func(_ obj, c obj) {
			at(c, "resource", "status", "requestDetails").(obj)["body"] = jsonString(obj{"cogniKey": key(1) + ":recover:1"})
		},
		"malformed response": func(_ obj, c obj) { at(c, "resource", "status", "response").(obj)["body"] = "null" },
		"malformed cache": func(_ obj, c obj) {
			at(c, "resource", "status").(obj)["cache"] = obj{"response": obj{"statusCode": 200, "body": "[]"}}
		},
		"cache handle conflict": func(_ obj, c obj) {
			at(c, "resource", "status").(obj)["cache"] = obj{"response": obj{"statusCode": 200, "body": `{"found":true,"resource":{"state":"active","externalName":"another-handle","endpoints":[]}}`}}
		},
		"no receipt with external cache": func(_ obj, c obj) {
			delete(at(c, "resource", "status").(obj), "requestDetails")
			at(c, "resource", "status").(obj)["cache"] = obj{"response": obj{"statusCode": 200, "body": `{"found":true,"resource":{"state":"active","externalName":"handle","endpoints":[]}}`}}
		},
		"recovery malformed count": func(f obj, _ obj) {
			status(f)["recovery"] = obj{"leaseGeneration": 1, "count": "1junk", "key": key(1) + ":recover:1", "maxAttempts": 3}
		},
		"recovery wrong key": func(f obj, _ obj) {
			status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 1, "key": key(1) + ":recover:2", "maxAttempts": 3}
		},
		"recovery wrong cap": func(f obj, _ obj) {
			status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 1, "key": key(1) + ":recover:1", "maxAttempts": 4}
		},
		"deleting selected": func(_ obj, c obj) { at(c, "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z" },
		"skipped observed ordinal": func(f obj, _ obj) {
			observed(f)["akash-lease-g1-recover-2"] = child(t, key(1)+":recover:2", blue, false, "akash-lease-g1-recover-2")
		},
		"occupied successor": func(f obj, _ obj) {
			observed(f)["akash-lease-g1-recover-1"] = child(t, key(0), blue, false, "akash-lease-g1-recover-1")
		},
	}
	for _, field := range []string{"nodeId", "compositeUid", "environment"} {
		field := field
		cases["wrong spec "+field] = func(_ obj, c obj) {
			var binding obj
			_ = json.Unmarshal([]byte(at(c, "resource", "spec", "forProvider", "payload", "body").(string)), &binding)
			if field == "environment" {
				binding[field] = "production"
			} else {
				binding["identity"].(obj)[field] = "other"
			}
			at(c, "resource", "spec", "forProvider", "payload").(obj)["body"] = jsonString(binding)
		}
	}
	for _, suffix := range []string{":recover:0", ":recover:4", ":recover:01", ":recover:1:extra", ":recover:-1"} {
		suffix := suffix
		cases["malformed family "+suffix] = func(_ obj, c obj) {
			var binding obj
			_ = json.Unmarshal([]byte(at(c, "resource", "spec", "forProvider", "payload", "body").(string)), &binding)
			binding["cogniKey"] = key(1) + suffix
			at(c, "resource", "spec", "forProvider", "payload").(obj)["body"] = jsonString(binding)
		}
	}
	for label, mutate := range cases {
		t.Run(label, func(t *testing.T) { f, c := r2ClosedBase(t, "Replace", true); mutate(f, c); r2WantFailure(t, tm, f) })
	}
	// Absence alone is not evidence that a previously allocated child can CREATE.
	f, c := r2ClosedBase(t, "Replace", true)
	r2Stamp(c, key(1), "active", false, false)
	active := render(t, tm, f)
	r2Merge(f, active)
	delete(observed(f), "akash-lease")
	r2WantFailure(t, tm, f)
	status(f)["resource"] = nil // Its own paid clock is also allocation history.
	r2WantFailure(t, tm, f)
}

func TestR2SelectedOnlyAndNativeSpecBeforeStatus(t *testing.T) {
	tm := loadTemplate(t)
	f, _ := r2ClosedBase(t, "Replace", true)
	first := render(t, tm, f)
	n := r2Check(t, first, 1)
	r2Merge(f, first)
	delete(observed(f), "akash-lease")
	current := r2Native(t, first.leases[n], n, "selected-only")
	observed(f)[n] = current // Complete spec/owner; no HTTP status exists yet.
	for i := 0; i < 3; i++ {
		o := render(t, tm, f)
		wantNames(t, o, n)
		r2Check(t, o, 1)
		if at(o.status, "resource", "id") != nil || at(o.status, "bootEpoch", "mintedAt") != nil || o.status["serving"] == true {
			t.Fatal("borrowed predecessor inputs", o.status)
		}
		if _, ok := o.status["resource"]; !ok {
			t.Fatal("resource clear must be explicit")
		}
	}
	// Legacy auxiliary-key repair needs the unique exact recorded receipt, not
	// a status-free child's payload or a maximum-family heuristic.
	legacy := r2Copy(t, f)
	delete(status(legacy)["recovery"].(obj), "key")
	r2WantFailure(t, tm, legacy)
	r2Stamp(observed(legacy)[n].(obj), key(1)+":recover:1", "pending", false, false)
	r2Check(t, render(t, tm, legacy), 1)
	// A foreign response on the selected native spec never authorizes key bypass.
	at(current, "resource").(obj)["status"] = obj{"requestDetails": obj{"body": jsonString(obj{"cogniKey": key(1)})}, "response": obj{"statusCode": 200, "body": `{"found":true,"serving":true,"resource":{"state":"closed","externalName":"old-handle","endpoints":[]}}`}}
	r2WantFailure(t, tm, f)
}

func TestR2PaidAmbiguityUsesOnlyOwnSuccessfulObservation(t *testing.T) {
	for _, cache := range []bool{false, true} {
		t.Run(fmt.Sprint(cache), func(t *testing.T) {
			tm := loadTemplate(t)
			f := fixture(1)
			seed := render(t, tm, f)
			c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "ambiguous")
			r2Stamp(c, key(1), "active", false, false)
			observed(f)["akash-lease"] = c
			annotations := at(c, "resource", "metadata", "annotations").(obj)
			annotations["crossplane.io/external-create-pending"] = "2026-10-30T00:00:00Z"
			at(c, "resource", "status").(obj)["conditions"] = []obj{{"message": "cannot determine creation result"}}
			if cache {
				st := at(c, "resource", "status").(obj)
				st["cache"] = obj{"response": r2Copy(t, st["response"].(obj))}
				st["response"] = obj{"statusCode": 503, "body": `{"code":"ledger_unavailable","message":"unknown"}`}
			}
			o := render(t, tm, f)
			wantNames(t, o, "akash-lease")
			if at(o.leases["akash-lease"], "metadata", "annotations", "crossplane.io/external-create-succeeded") != "2026-10-30T00:00:00Z" {
				t.Fatal("own proven allocation could not recover native ambiguity")
			}
			r2Cleanup(t, o.leases["akash-lease"], key(1))
			// Error/null bodies never contain another child's handle in emitted mappings.
			remove := r2Mapping(t, o.leases["akash-lease"], "REMOVE")["body"].(string)
			if strings.Contains(remove, "handle-") || strings.Contains(remove, "status.resource") {
				t.Fatal("cleanup borrowed a handle")
			}
		})
	}
}

func TestR2MigrationAndRefusalStatusStayObservational(t *testing.T) {
	tm := loadTemplate(t)
	for _, mode := range []string{"fresh-migration-failure", "cleared-migration-failure", "retryable-refusal", "terminal-refusal", "budget-before-refusal"} {
		t.Run(mode, func(t *testing.T) {
			f := fixture(1)
			seed := render(t, tm, f)
			c := r2Native(t, seed.leases["akash-lease"], "akash-lease", "status")
			r2Stamp(c, key(1), "active", false, false)
			observed(f)["akash-lease"] = c
			initial := render(t, tm, f)
			r2Merge(f, initial)
			reason, phase := "MigrationFailed", "Failed"
			response := at(c, "resource", "status", "response").(obj)
			switch mode {
			case "fresh-migration-failure", "cleared-migration-failure":
				var body obj
				_ = json.Unmarshal([]byte(response["body"].(string)), &body)
				migration := "failed"
				if mode == "cleared-migration-failure" {
					migration = "succeeded"
					reason = "None"
					phase = "Progressing"
					status(f)["migration"] = obj{"phase": "failed"}
				}
				body["migration"] = obj{"phase": migration}
				response["body"] = jsonString(body)
			case "retryable-refusal":
				reason = "wallet_allocation_blocked"
				phase = "Progressing"
				response["statusCode"] = 409
				response["body"] = jsonString(obj{"code": reason, "message": "retry same key"})
			case "terminal-refusal":
				reason = "identity_conflict"
				response["statusCode"] = 422
				response["body"] = jsonString(obj{"code": reason, "message": "wrong owner"})
			case "budget-before-refusal":
				reason = "BootDeadlineClosed"
				xr(f)["spec"].(obj)["bootPolicy"] = obj{"onDeadline": "Close", "bootDeadlineSeconds": 60}
				status(f)["bootEpoch"].(obj)["mintedAt"] = "2000-01-01T00:00:00Z"
				response["statusCode"] = 503
				response["body"] = `{"code":"ledger_unavailable","message":"unknown"}`
			}
			o := render(t, tm, f)
			wantNames(t, o, "akash-lease")
			if at(o.status, "failure", "reason") != reason || o.status["phase"] != phase || at(o.status, "recovery", "count") != nil || paid(o, "akash-lease") != key(1) {
				t.Fatal("observational failure altered paid identity/ranking", mode, o.status)
			}
			if mode == "budget-before-refusal" && at(o.status, "resource", "id") != at(initial.status, "resource", "id") {
				t.Fatal("own handle lost through refusal")
			}
		})
	}
}
