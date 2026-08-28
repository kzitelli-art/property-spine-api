FROM node:22-alpine

WORKDIR /app

# Install dependencies first (layer caching). From the LOCKFILE — the
# lockfile ignored outright means every build resolves fresh versions, so a
# desynced package.json silently ships different code than CI verified.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy application source
COPY . .

EXPOSE 3000

# prestart VERIFIES the schema and REFUSES TO START on mismatch — it does
# not apply anything. Releasing schema is a separate, deliberate act; see
# docs/deployment.md. A container that exits here has not failed to boot,
# it has declined to run new code against an older database.
CMD ["npm", "start"]
