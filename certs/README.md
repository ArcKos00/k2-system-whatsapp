# CA certificates

Drop internal/corporate **CA certificates** here before building `Dockerfile.base`.

Rules:

- Files must be **PEM-encoded** and have a **`.crt`** extension
  (rename `.pem` → `.crt` if needed). `update-ca-certificates` ignores everything
  else, so this README is harmless.
- One certificate per file. Use descriptive names, e.g. `k2-root-ca.crt`,
  `k2-rabbitmq-ca.crt`.
- These are **public CA certs**, not private keys — do not put `.key` files here.

They are installed into `/usr/local/share/ca-certificates/` and registered via
`update-ca-certificates`, then exposed to Node through `NODE_EXTRA_CA_CERTS`.
