FROM node:22-slim
LABEL org.opencontainers.image.title="AgentMesh"
LABEL org.opencontainers.image.description="Production-grade multi-agent coordination kernel with semantic CRDT, MACP bounded sessions, and live web canvas."
LABEL org.opencontainers.image.url="https://github.com/harshalsp07/AgentMesh"
LABEL org.opencontainers.image.source="https://github.com/harshalsp07/AgentMesh"
LABEL org.opencontainers.image.licenses="MIT"
RUN useradd -m mesh && mkdir -p /data && chown mesh:mesh /data
WORKDIR /app
COPY package.json ./
COPY src ./src
COPY site ./site
COPY templates ./templates
COPY bin ./bin
ENV MESH_DIR=/data MESH_HOST=0.0.0.0 MESH_PORT=7777 NODE_ENV=production
EXPOSE 7777
USER mesh
HEALTHCHECK --interval=15s --timeout=5s CMD node -e "fetch('http://127.0.0.1:7777/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "src/hub.mjs"]
