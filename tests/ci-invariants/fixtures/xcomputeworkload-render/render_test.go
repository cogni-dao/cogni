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
				"apiVersion": "compute.cogni.dev/v1alpha1", "kind": "XComputeWorkload",
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
func child(paidKey, target string, serving bool) obj {
	endpoints := []string{target}
	if serving {
		endpoints = append(endpoints, host)
	}
	return obj{"resource": obj{
		"metadata": obj{"name": "request-stable", "uid": "request-uid"},
		"status":   obj{"requestDetails": obj{"body": jsonString(obj{"cogniKey": paidKey})}, "response": obj{"statusCode": 200, "body": jsonString(obj{"found": true, "serving": serving, "resource": obj{"state": "active", "externalName": "lease-stable", "endpoints": endpoints}})}},
	}}
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
	if !reflect.DeepEqual(names(out), want) {
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
	incumbent := child(key(1), blue, true)
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
	observed(f)["akash-lease-g0"] = child(key(0), green, false)
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
				observed(f)[name] = child(key(1), blue, true)
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
			observed(f)["akash-lease"] = child(k, blue, true)
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
	observed(familyBoundary)["akash-lease"] = child(key(10), blue, true)
	boundary := render(t, tmpl, familyBoundary)
	wantNames(t, boundary, "akash-lease", "akash-lease-g1")
	if paid(boundary, "akash-lease") != key(10) || paid(boundary, "akash-lease-g1") != key(1) {
		t.Fatal("generation-prefix collision")
	}
	// Kubernetes may serialize an unset deletion timestamp as null.
	notDeleting := fixture(1)
	observed(notDeleting)["akash-lease"] = child(key(1), blue, true)
	at(observed(notDeleting)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = nil
	wantNames(t, render(t, tmpl, notDeleting), "akash-lease")
	// An empty observation is bootstrap, not a paid receipt.
	f := fixture(2)
	wantNames(t, render(t, tmpl, f), "akash-lease")
}

func TestUnsafeObservationsFailWholeRender(t *testing.T) {
	tmpl := loadTemplate(t)
	cases := map[string]func(obj){
		"duplicate exact":  func(f obj) { observed(f)["akash-lease-g1"] = child(key(1), blue, true) },
		"duplicate family": func(f obj) { observed(f)["akash-lease-g1"] = child(key(1)+":recover:1", blue, true) },
		"deleting desired": func(f obj) {
			at(observed(f)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
		},
		"deleting duplicate": func(f obj) {
			c := child(key(1), blue, true)
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
		"missing recovery status": func(f obj) { observed(f)["akash-lease"] = child(key(1)+":recover:2", blue, true) },
		"wrong recovery generation": func(f obj) {
			observed(f)["akash-lease"] = child(key(1)+":recover:2", blue, true)
			status(f)["recovery"] = obj{"leaseGeneration": 0, "count": 2}
		},
		"active duplicate": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			observed(f)["akash-lease-g1"] = child(key(1), blue, true)
		},
		"active deleting": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			at(observed(f)["akash-lease"].(obj), "resource", "metadata").(obj)["deletionTimestamp"] = "2026-10-31T00:55:47Z"
		},
		"occupied new name": func(f obj) {
			xr(f)["spec"].(obj)["leaseGeneration"] = 2
			observed(f)["akash-lease-g2"] = child(key(0), blue, true)
		},
	}
	cases["leading-zero generation"] = func(f obj) { observed(f)["akash-lease"] = child(strings.TrimSuffix(key(1), "1")+"01", blue, true) }
	cases["recovery count behind"] = func(f obj) {
		observed(f)["akash-lease"] = child(key(1)+":recover:2", blue, true)
		status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 1}
	}
	cases["recovery count ahead"] = func(f obj) {
		observed(f)["akash-lease"] = child(key(1)+":recover:1", blue, true)
		status(f)["recovery"] = obj{"leaseGeneration": 1, "count": 2}
	}
	for _, suffix := range []string{":recover:0", ":recover:4", ":recover:01", ":recover:1:extra", ":recover:", ":recover:-1"} {
		suffix := suffix
		cases["malformed "+suffix] = func(f obj) { observed(f)["akash-lease"] = child(key(1)+suffix, blue, true) }
	}
	for name, mutate := range cases {
		t.Run(name, func(t *testing.T) {
			f := fixture(1)
			observed(f)["akash-lease"] = child(key(1), blue, true)
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
	observed(f)["akash-lease"] = child(key(1), blue, true)
	dns(f, blue)
	initial := render(t, tmpl, f)
	wantNames(t, initial, "akash-lease", "akash-lease-g2")
	if dnsTarget(initial) != blue || initial.status["activeLeaseGeneration"] != 1 {
		t.Fatal("cut over before candidate exists")
	}
	observed(f)["akash-lease-g2"] = child(key(2), green, false)
	booting := render(t, tmpl, f)
	wantNames(t, booting, "akash-lease", "akash-lease-g2")
	if dnsTarget(booting) != blue {
		t.Fatal("traffic before proof")
	}
	// A serving result without the provider admitting the host is insufficient.
	c := child(key(2), green, false)
	at(c, "resource", "status", "response").(obj)["body"] = jsonString(obj{"found": true, "serving": true, "resource": obj{"state": "active", "externalName": "lease-green", "endpoints": []string{green}}})
	observed(f)["akash-lease-g2"] = c
	if dnsTarget(render(t, tmpl, f)) != blue {
		t.Fatal("unadmitted host moved traffic")
	}
	observed(f)["akash-lease-g2"] = child(key(2), green, true)
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
