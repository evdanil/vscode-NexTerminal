# Containerlab inspect fixtures

These are sanitized captures of `containerlab --runtime docker --topo= --name= --timeout 20s inspect --all --details --format json` from the official `ghcr.io/srl-labs/clab` images:

- `inspect-0.68.0.json`: `ghcr.io/srl-labs/clab@sha256:22b2389319f3793d151fc0e4d91e59889a0b9584ad7aa257c04355d0e7af1874`
- `inspect-0.80.0.json`: `ghcr.io/srl-labs/clab@sha256:a0b8bc9da0f88323f63d7ab53b9729564076b13a9d89a9ba5a28c66fa80a665d`

The captures came from a disposable, stopped synthetic Docker container carrying Containerlab labels. The runtime had no network, no extra capabilities, and only the selected Docker socket mounted. The fixture shape retains the actual detailed fields emitted by each image. The lab/container names, IDs, image, owner, topology path, and validation-label value were sanitized; no real host or lab name is included. The 0.80 capture includes its observed additive `Runtime` object.

Field names were checked against the pinned runtime implementations and release documentation:

- [Containerlab 0.68.0 Docker runtime source](https://github.com/srl-labs/containerlab/blob/v0.68.0/runtime/docker/docker.go) constructs the generic-container list and its label/runtime details.
- [Containerlab 0.80.0 Docker runtime source](https://github.com/srl-labs/containerlab/blob/v0.80.0/runtime/docker/docker.go) constructs the corresponding 0.80 details, including its additive runtime field.
- [Release 0.68 notes](https://containerlab.dev/rn/0.68/) record the grouped-by-lab JSON inspection change.
- [Release 0.80 notes](https://containerlab.dev/rn/0.80/) document the release whose inspection output can expose internal helper containers.
- [Inspect command reference](https://containerlab.dev/cmd/inspect/) documents the summary projection; these fixtures specifically preserve detailed `GenericContainer` output instead of that summary shape.

Parser tests load these files and mutate their real `NetworkSettings` address and prefix fields, labels, row arrays, and runtime state. The test IP addresses and changed row values are synthetic; they exercise the observed fields and do not claim to be captured lab addresses. Prefix length zero remains valid for non-empty addresses because the 0.80 static-IPAM path can emit it.
