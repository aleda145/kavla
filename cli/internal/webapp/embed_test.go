package webapp

import (
	"bytes"
	"testing"
)

func TestIconIsBundled(t *testing.T) {
	icon, err := Icon()
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(icon, []byte("<svg")) {
		t.Fatal("embedded Kavla icon is not SVG data")
	}
}
