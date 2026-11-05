# use Node 22 image as a builder
FROM node:22-alpine AS builder

# work under the /app directory
WORKDIR /app

# copy files required to install dependencies first
COPY package.json package-lock.json svelte.config.js ./

# install the dependencies, including dev ones.
# SvelteKit package itself is a dev dependency and we need it for building the app.
RUN npm ci

# copy all the sources
COPY . .

# build the app
RUN npm run build

# delete all the dev dependencies from the "node_modules",
# they are no longer needed.
RUN npm prune --production

# take the distroless Node 22 image
FROM gcr.io/distroless/nodejs22-debian13

# work under the /app directory
WORKDIR /app

# copy the built app, dependencies and the package file
# as described in the Svelte adapter-node docs
COPY --from=builder /app/build server/
COPY --from=builder /app/node_modules node_modules/
COPY package.json .

# expose the app server port
EXPOSE 3000

# tell Node and other code this is production
ENV NODE_ENV=production

# run the app server (entrypoint is node)
CMD ["server"]

