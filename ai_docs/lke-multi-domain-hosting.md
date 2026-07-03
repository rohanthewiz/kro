# Hosting Multiple App Domains on a Single Linode/Akamai Kubernetes (LKE) Cluster

Goal: serve several low-traffic, single-binary Go apps (assets embedded), each on its own
domain, from one small LKE cluster — sharing resources and paying for only one load balancer.

## Architecture

One cluster, one load balancer, one public IP. All domains point at that single IP, and an
ingress controller inside the cluster routes by hostname:

```
app1.example.com ─┐
app2.dev       ───┼─→ NodeBalancer (one IP) → ingress-nginx → Service → Go pods
blog.example.io ──┘
```

**Key cost insight:** on LKE, every `Service` of type `LoadBalancer` provisions its own Linode
NodeBalancer (~$10/mo each). Deliberately create **one** — the ingress controller's — and make
every app a cheap internal `ClusterIP` service behind it.

**Sizing/cost** for light traffic: LKE's control plane is free, so cost = nodes + NodeBalancer.
Two 2GB shared nodes (~$12/mo each) + NodeBalancer ≈ **$34/mo**, comfortably running a dozen
small Go apps. A single 4GB node also works if downtime during node upgrades is tolerable.

## One-time cluster setup

1. **Create the cluster** in Linode Cloud Manager (Kubernetes → Create), download the
   kubeconfig, then:
   ```bash
   export KUBECONFIG=~/Downloads/<cluster>-kubeconfig.yaml
   ```

2. **Install ingress-nginx** (this creates the one NodeBalancer):
   ```bash
   helm upgrade --install ingress-nginx ingress-nginx \
     --repo https://kubernetes.github.io/ingress-nginx \
     --namespace ingress-nginx --create-namespace
   kubectl get svc -n ingress-nginx   # note the EXTERNAL-IP
   ```

3. **Install cert-manager** for free auto-renewing Let's Encrypt TLS:
   ```bash
   helm upgrade --install cert-manager cert-manager \
     --repo https://charts.jetstack.io \
     --namespace cert-manager --create-namespace --set crds.enabled=true
   ```

   Then apply one `ClusterIssuer`:
   ```yaml
   apiVersion: cert-manager.io/v1
   kind: ClusterIssuer
   metadata:
     name: letsencrypt
   spec:
     acme:
       server: https://acme-v02.api.letsencrypt.org/directory
       email: rohanthewiz@gmail.com
       privateKeySecretRef:
         name: letsencrypt-key
       solvers:
         - http01:
             ingress:
               ingressClassName: nginx
   ```

4. **DNS:** an A record for each domain → the NodeBalancer's external IP. Linode's DNS manager
   is free if consolidating there, but any DNS host works.

## Per-app deployment (the repeating unit)

Single-binary Go apps with embedded assets are the ideal case — build `FROM scratch` or
distroless images that are a few MB:

```dockerfile
FROM golang:1.24 AS build
WORKDIR /src
COPY . .
RUN CGO_ENABLED=0 go build -o /app .

FROM gcr.io/distroless/static
COPY --from=build /app /app
ENTRYPOINT ["/app"]
```

Push to GHCR (free for public images; private images need an image-pull secret in the cluster).
Each app is then a Deployment + Service + Ingress:

```yaml
apiVersion: apps/v1
kind: Deployment
metadata: { name: app1 }
spec:
  replicas: 1
  selector: { matchLabels: { app: app1 } }
  template:
    metadata: { labels: { app: app1 } }
    spec:
      containers:
        - name: app1
          image: ghcr.io/rohanthewiz/app1:latest
          ports: [{ containerPort: 8080 }]
          resources:
            requests: { cpu: 25m, memory: 32Mi }
            limits: { memory: 128Mi }
---
apiVersion: v1
kind: Service
metadata: { name: app1 }
spec:
  selector: { app: app1 }
  ports: [{ port: 80, targetPort: 8080 }]
---
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: app1
  annotations:
    cert-manager.io/cluster-issuer: letsencrypt
spec:
  ingressClassName: nginx
  tls:
    - hosts: [app1.example.com]
      secretName: app1-tls
  rules:
    - host: app1.example.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service: { name: app1, port: { number: 80 } }
```

Adding domain N+1 = copy that trio with a new name/host. cert-manager notices the new Ingress
and issues the certificate automatically, usually within a minute of DNS resolving.

## Notes

- **Resource requests matter.** Go apps idle at ~10–20MB RSS; small requests (as above) are
  what let many apps pack onto two small nodes. Omitting them prevents efficient scheduling.
- **Honest alternative:** if "a few light apps" stays a few, a single $12 Linode running Caddy
  (automatic HTTPS, host-based routing in ~5 lines) plus binaries under systemd is a third the
  cost with less moving machinery. LKE earns its keep with rolling deploys, easy rollbacks, and
  room to grow — choose it deliberately.
- Possible next step: a small reusable Helm chart or kustomize base so each new app is a
  ~5-line values file.
