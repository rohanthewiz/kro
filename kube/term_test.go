package kube

import (
	"reflect"
	"testing"
)

func TestTokenizeArgs(t *testing.T) {
	cases := []struct {
		in   string
		want []string
	}{
		{"", nil},
		{"get pods", []string{"get", "pods"}},
		{"  get   pods  ", []string{"get", "pods"}},
		{"get pods -l app=foo", []string{"get", "pods", "-l", "app=foo"}},
		{"describe pod my-pod-1", []string{"describe", "pod", "my-pod-1"}},
		{`get pod 'has spaces'`, []string{"get", "pod", "has spaces"}},
		{`get pod "double quoted"`, []string{"get", "pod", "double quoted"}},
		{`exec mypod -- sh -c "echo hi"`, []string{"exec", "mypod", "--", "sh", "-c", "echo hi"}},
		{`run --image="busybox:1.36" foo`, []string{"run", "--image=busybox:1.36", "foo"}},
		{`literal\ space`, []string{"literal space"}},
		{`get pod "with \"quotes\""`, []string{"get", "pod", `with "quotes"`}},
	}
	for _, tc := range cases {
		got, err := TokenizeArgs(tc.in)
		if err != nil {
			t.Errorf("TokenizeArgs(%q) error: %v", tc.in, err)
			continue
		}
		if !reflect.DeepEqual(got, tc.want) {
			t.Errorf("TokenizeArgs(%q) = %#v, want %#v", tc.in, got, tc.want)
		}
	}
}

func TestTokenizeArgs_Unterminated(t *testing.T) {
	cases := []string{
		`get pod "missing`,
		`get pod 'missing`,
	}
	for _, in := range cases {
		if _, err := TokenizeArgs(in); err == nil {
			t.Errorf("TokenizeArgs(%q) expected error, got nil", in)
		}
	}
}