const fs = require('fs');
const toml = require('toml');
const https = require('https');

class VarsReader {
  constructor(currentEnv, varsFilePath = '.vars.toml') {
    const varsBuffer = fs.readFileSync(varsFilePath);
    this.data = toml.parse(varsBuffer);
    this.currentEnv = currentEnv;
  }

  get(key, defaultValue = null) {
    const envDict = this.data[this.currentEnv] || {};
    return envDict[key] || this.data[key] || defaultValue;
  }

  flattenVars() {
    const varDict = {};
    const keys = Object.keys(this.data).filter((k) => !['production', 'preview', 'development'].includes(k))
    keys.forEach((k) => {
      varDict[k] = this.get(k, '');
    });
    return varDict;
  }
}

class WranglerCmd {
  constructor(currentEnv) {
    this.currentEnv = currentEnv;
    this.v = new VarsReader(currentEnv);
  }

  _getCmd(wranglerCmd) {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID || this.v.get('CLOUDFLARE_ACCOUNT_ID');
    const apiToken = process.env.CLOUDFLARE_API_TOKEN || this.v.get('CLOUDFLARE_API_TOKEN');
    
    return `CLOUDFLARE_ACCOUNT_ID=${accountId} ` +
      `CLOUDFLARE_API_TOKEN=${apiToken} ` + wranglerCmd;
  }

  publishProject() {
    const projectName = this.v.get('CLOUDFLARE_PROJECT_NAME');
    const productionBranch = this.v.get('PRODUCTION_BRANCH', 'main');

    // Cloudflare Pages direct upload uses branch to decide deployment environment.
    // If we want production, then use production_branch. Otherwise, just something else
    const branch = this.currentEnv === 'production' ? productionBranch : `${productionBranch}-preview`;
    const wranglerCmd = `wrangler pages deploy public --project-name ${projectName} --branch ${branch}`;
    console.log(wranglerCmd);
    return this._getCmd(wranglerCmd);
  }

  _non_dev_db() {
    return this.v.get('D1_DATABASE_NAME') ||
      `${this.v.get('CLOUDFLARE_PROJECT_NAME')}_feed_db_${this.currentEnv}`;
  }

  createFeedDb() {
    const wranglerCmd = this.currentEnv !== 'development' ?
      `wrangler d1 create ${this._non_dev_db()}` : 'echo "FEED_DB"';
    console.log(wranglerCmd);
    return this._getCmd(wranglerCmd);
  }

  createFeedDbTables() {
    const dbName = this.currentEnv !== 'development' ?
      `${this._non_dev_db()} --remote` : 'FEED_DB --local';
    const wranglerCmd = `wrangler d1 execute ${dbName} -e ${this.currentEnv} --file ops/db/init.sql`;
    console.log(wranglerCmd);
    return this._getCmd(wranglerCmd);
  }

  /**
   * XXX: We use private api here, which may be changed on the cloudflare end...
   * https://github.com/cloudflare/wrangler2/blob/main/packages/wrangler/src/d1/list.tsx#L34
   */
  getDatabaseId(onSuccess) {
    const dbName = this.currentEnv !== 'development' ? this._non_dev_db() : 'FEED_DB';
    const accountId = this.v.get('CLOUDFLARE_ACCOUNT_ID');
    const apiKey = this.v.get('CLOUDFLARE_API_TOKEN');
    const options = {
      host: 'api.cloudflare.com',
      port: '443',
      path: `/client/v4/accounts/${accountId}/d1/database?name=${dbName}`,
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
    };
    const request = https.request(options, (response) => {
      let data = '';
      response.on('data', (chunk) => {
        data = data + chunk.toString();
      });

    response.on('end', () => {
      let body;
      try {
        body = JSON.parse(data);
      } catch (e) {
        console.error('[utils.js] JSON parse failed. Raw response:', data.toString());
        throw new Error(`Invalid JSON response from API: ${e.message}`);
      }

      // 核心修复：防御性检查 result 是否为有效数组
      const results = body?.result;
      if (!Array.isArray(results)) {
        console.error('[utils.js] Expected body.result to be an array, but got:', typeof results, results);
        console.error('[utils.js] Full response body:', JSON.stringify(body, null, 2));
        throw new Error(`API returned unexpected structure: body.result is ${results === null ? 'null' : typeof results}`);
      }

      let databaseId = '';
      results.forEach((result) => {
        if (result.name === dbName) {
          databaseId = result.uuid;
        }
      });

  // 可选：如果 databaseId 必须存在，建议在此处也加校验
  if (!databaseId) {
    console.warn(`[utils.js] Database "${dbName}" not found in API response`);
  }

  // ... 后续逻辑继续使用 databaseId
});
    })

    request.on('error', (error) => {
      console.log('An error', error);
      onSuccess('');
    });

    request.end();
  }
}

module.exports = {
  VarsReader,
  WranglerCmd,
};
