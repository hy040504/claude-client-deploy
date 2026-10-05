export default class ClaudeArkose {
  /**
   * 계정별 Arkose 요청 설정을 보관한다.
   * @param {object} config - 공개 키와 요청 주소를 포함한 설정
   * @returns {ClaudeArkose} 초기화된 요청 객체
   */
  constructor(config = {}) {
    this.config = config;

    this.publicKey = config.arkosePublicKey || "EEA5F558-D6AC-4C03-B678-AABF639EE69A";
    this.site = config.arkoseSite || "https://claude.ai";
    this.baseUrl = config.arkoseBaseUrl || "https://a-cdn.claude.ai";

    this.userAgent =
      config.userAgent ||
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36";

    this.arkBuildId = config.arkoseBuildId || "7ecbd953-09aa-4047-9b10-febe0ed32f28";

    this.defaultHttpClient = null;
  }

  /**
   * 로그인과 같은 쿠키를 쓰도록 외부 HTTP 클라이언트를 연결한다.
   * @param {object} httpClient - 로그인 흐름에서 만든 HTTP 클라이언트
   * @returns {void} 반환값 없음
   */
  setHttpClient(httpClient) {
    this.defaultHttpClient = httpClient;
  }

  /**
   * 앞서 연결한 HTTP 클라이언트를 꺼내고 누락 시 설정 오류를 알린다.
   * @returns {object} 연결된 HTTP 클라이언트
   * @throws {Error} HTTP 클라이언트를 먼저 지정하지 않은 경우
   */
  getHttpClient() {
    if (!this.defaultHttpClient) {
      throw new Error("[arkose] HTTP client (CycleTLS) not set. Call setHttpClient() first.");
    }
    return this.defaultHttpClient;
  }

  /**
   * 로그인에 사용할 Arkose 세션을 시작하고 서버의 빌드 정보를 보관한다.
   * @param {object|null} httpClient - 직접 지정할 클라이언트 또는 기본값을 쓸 경우 null
   * @returns {Promise<object>} 세션 토큰과 서버 원본 응답
   */
  async initSession(httpClient = null) {
    const http = httpClient || this.getHttpClient();
    const url = `${this.baseUrl}/fc/gt2/public_key/${this.publicKey}`;

    const response = await http.post(
      url,
      {
        public_key: this.publicKey,
        site: this.site
      },
      {
        headers: {
          Origin: "https://claude.ai",
          Referer: "https://claude.ai/",
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const sessionToken = response.data?.token || response.headers?.["session-id"];

    if (response.headers?.["ark-build-id"]) {
      this.arkBuildId = response.headers["ark-build-id"];
    }

    console.log(`[arkose] Session initialized → ${sessionToken?.slice(0, 55)}...`);
    return { sessionToken, raw: response.data };
  }

  /**
   * 외부에서 얻은 검증 결과를 현재 설정의 Arkose 서버에 제출한다.
   * @param {object|null} httpClient - 요청에 사용할 클라이언트
   * @param {string} sessionToken - 기존 호출 형식과의 호환을 위해 받는 세션 토큰
   * @param {string} cValue - c=로 시작하는 검증 결과
   * @returns {Promise<object>} 서버 응답 본문
   * @throws {Error} 검증 결과가 c= 형식이 아닌 경우
   */
  async submitChallenge(httpClient = null, sessionToken, cValue) {
    if (!cValue?.startsWith("c=")) {
      throw new Error('Arkose solution must start with "c="');
    }

    const http = httpClient || this.getHttpClient();
    const url = `${this.baseUrl}/fc/gt2/public_key/${this.publicKey}`;

    const body = `${cValue}&public_key=${this.publicKey}&site=${encodeURIComponent(this.site)}`;

    const response = await http.post(url, body, {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Origin: "https://claude.ai",
        Referer: "https://claude.ai/",
        "x-ark-esync-value": Math.floor(Date.now() / 1000).toString(),
        "ark-build-id": this.arkBuildId
      }
    });

    console.log(`[arkose] Challenge submitted → ${response.status}`);
    return response.data;
  }

  /**
   * 세션 초기화 알림을 전송하되 알림 실패로 로그인 흐름을 중단하지 않는다.
   * @param {object|null} httpClient - 요청에 사용할 클라이언트
   * @param {string} sessionToken - 알림을 연결할 세션 토큰
   * @returns {Promise<void>} 알림 전송 시도 완료
   */
  async sendGameLoaded(httpClient = null, sessionToken) {
    const http = httpClient || this.getHttpClient();
    const callback = `__jsonp_${Date.now()}${Math.floor(Math.random() * 99999)}`;

    const params = new URLSearchParams({
      callback,
      category: "loaded",
      action: "game loaded",
      session_token: sessionToken,
      "data[public_key]": this.publicKey,
      "data[site]": this.site
    });

    await http.get(`${this.baseUrl}/fc/a/?${params.toString()}`).catch(() => {});
    console.log("[arkose] Game loaded event sent");
  }

  /**
   * 세션 시작, 외부 검증 결과 제출, 초기화 알림을 순서대로 실행한다.
   * @param {object|null} httpClient - 요청에 사용할 클라이언트
   * @param {string} cValue - 외부에서 전달받은 검증 결과
   * @returns {Promise<string>} 시작한 세션의 토큰
   */
  async fullSolve(httpClient = null, cValue) {
    const http = httpClient || this.getHttpClient();
    const { sessionToken } = await this.initSession(http);

    await this.submitChallenge(http, sessionToken, cValue);
    await this.sendGameLoaded(http, sessionToken);

    return sessionToken;
  }
}
