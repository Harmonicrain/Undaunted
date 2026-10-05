'use strict';
const { Provider } = require('electron-updater/out/providers/Provider');
const { fetchManifest, verifyManifest } = require('./update-feed.cjs');

// The pinned electron-updater custom-provider API handles NSIS download/cache/
// differential updates. Discovery uses our signed JSON, not unsigned latest.yml.
class SignedUpdateProvider extends Provider {
  constructor(config, updater, runtime) { super({ ...runtime, isUseMultipleRangeRequest: false }); this.config = config; }
  async getLatestVersion() {
    await this.config.beforeCheck();
    const envelope = await fetchManifest(this.config, this.config.fetcher);
    const manifest = verifyManifest(envelope, this.config);
    this.config.acceptManifest(manifest, envelope);
    return structuredClone(manifest);
  }
  resolveFiles(info) {
    return info.files.map(file => ({ url: new URL(file.url, this.config.url), info: file }));
  }
}
module.exports = { SignedUpdateProvider };
