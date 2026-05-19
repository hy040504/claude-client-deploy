// src/arkose/claude-arkose.js
export default class ClaudeArkose {
    constructor(config = {}) {
        this.config = config;

        this.publicKey = config.arkosePublicKey || 'EEA5F558-D6AC-4C03-B678-AABF639EE69A';
        this.site = config.arkoseSite || 'https://claude.ai';
        this.baseUrl = config.arkoseBaseUrl || 'https://a-cdn.claude.ai';
        
        this.userAgent = config.userAgent || 
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36';
        
        this.arkBuildId = config.arkoseBuildId || '7ecbd953-09aa-4047-9b10-febe0ed32f28';

        this.defaultHttpClient = null;
    }

    setHttpClient(httpClient) {
        this.defaultHttpClient = httpClient;
    }

    getHttpClient() {
        if (!this.defaultHttpClient) {
            throw new Error('[arkose] HTTP client (CycleTLS) not set. Call setHttpClient() first.');
        }
        return this.defaultHttpClient;
    }

    async initSession(httpClient = null) {
        const http = httpClient || this.getHttpClient();
        const url = `${this.baseUrl}/fc/gt2/public_key/${this.publicKey}`;

        const response = await http.post(url, {
            public_key: this.publicKey,
            site: this.site
        }, {
            headers: {
                'Origin': 'https://claude.ai',
                'Referer': 'https://claude.ai/',
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        const sessionToken = response.data?.token || response.headers?.['session-id'];

        if (response.headers?.['ark-build-id']) {
            this.arkBuildId = response.headers['ark-build-id'];
        }

        console.log(`[arkose] Session initialized → ${sessionToken?.slice(0, 55)}...`);
        return { sessionToken, raw: response.data };
    }

    async submitChallenge(httpClient = null, sessionToken, cValue) {
        if (!cValue?.startsWith('c=')) {
            throw new Error('Arkose solution must start with "c="');
        }

        const http = httpClient || this.getHttpClient();
        const url = `${this.baseUrl}/fc/gt2/public_key/${this.publicKey}`;

        const body = `${cValue}&public_key=${this.publicKey}&site=${encodeURIComponent(this.site)}`;

        const response = await http.post(url, body, {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
                'Origin': 'https://claude.ai',
                'Referer': 'https://claude.ai/',
                'x-ark-esync-value': Math.floor(Date.now() / 1000).toString(),
                'ark-build-id': this.arkBuildId
            }
        });

        console.log(`[arkose] Challenge submitted → ${response.status}`);
        return response.data;
    }

    async sendGameLoaded(httpClient = null, sessionToken) {
        const http = httpClient || this.getHttpClient();
        const callback = `__jsonp_${Date.now()}${Math.floor(Math.random() * 99999)}`;

        const params = new URLSearchParams({
            callback,
            category: 'loaded',
            action: 'game loaded',
            session_token: sessionToken,
            'data[public_key]': this.publicKey,
            'data[site]': this.site
        });

        await http.get(`${this.baseUrl}/fc/a/?${params.toString()}`).catch(() => {});
        console.log('[arkose] Game loaded event sent');
    }

    async fullSolve(httpClient = null, cValue) {
        const http = httpClient || this.getHttpClient();
        const { sessionToken } = await this.initSession(http);
        
        await this.submitChallenge(http, sessionToken, cValue);
        await this.sendGameLoaded(http, sessionToken);

        return sessionToken;
    }
}