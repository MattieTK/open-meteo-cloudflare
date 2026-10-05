# The official Open-Meteo server image, unmodified. Cloudflare Containers can only start images from
# registry.cloudflare.com, so `cf deploy` rebuilds this one-line file and pushes the result there; the
# layers are the upstream ones, byte for byte.
#
# Pinned by tag and digest. To update, see "Updating the Open-Meteo image" in README.md, and change
# OPEN_METEO_IMAGE in src/image.ts to match.
FROM ghcr.io/open-meteo/open-meteo:1.6.0@sha256:e1517a01a061fd96e2a9017d022c5809bb51725bcd733bcbed435e7ea32dd9da
