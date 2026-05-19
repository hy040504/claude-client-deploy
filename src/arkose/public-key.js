import chalk from "chalk";

/**
 * Arkose Public Key 요청을 직접 수행하여 세션 토큰 및 c= 값을 획득한다.
 * (실제 패킷 분석 기반 구현)
 */
export async function fetchArkosePublicKey() {
  const publicKey = "EEA5F558-D6AC-4C03-B678-AABF639EE69A";
  const url = `https://a-cdn.claude.ai/fc/gt2/public_key/${publicKey}`;

  console.log(chalk.cyan(`\n[arkose] 🔐 Arkose Public Key 요청 시도...`));
  console.log(chalk.cyan(`[arkose] URL: ${url}`));

  const payload = new URLSearchParams({
    c: 'OKH5WcvHxhitDZMTDGpt6iasYXWaRrSbsDwOrg==Ykc//Jn9cGKSJJ0nXg7zfWFVR1u3QSUZtrW17gPgjWl0dRjsxzzY1xR0aur3bmNLBSgSSeNdPOWY2lb4UlSanzR/OmXU8Yuc1YuBX75oa9wwyRXOXzUgTac07mEkes0ZQLRYZAdZ9I4uf/KEvDd7zYIOUBWq2GULLamfNT9g1wCWFlCmE1nqG+Lo50QEkAyqEn5FTfqEF52gTr8z8Lfn+c0OfdXyjgoC5gfgrraiZOfbiidcsO0kVXmXceY5k9aT/Knv0ln4URAnPlMmMOWrUUlfUEcamTAO4wJkR2+PjvN5zPl0PNSuW9POE9d5peUOg5e/U/4ZPVchx4ykYXwhfQ==',
    public_key: publicKey,
    site: 'https://claude.ai',
    userbrowser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
    capi_version: '4.2.1',
    capi_mode: 'lightbox',
    style_theme: 'default',
    rnd: Math.random().toString()
  });

  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'Origin': 'https://claude.ai',
    'Referer': 'https://claude.ai/',
    'ark-build-id': '7ecbd953-09aa-4047-9b10-febe0ed32f28',
    'x-ark-esync-value': Math.floor(Date.now() / 1000).toString()
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: payload.toString()
    });

    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.log(chalk.red(`[arkose] ❌ Public Key 응답 JSON 파싱 실패`));
      return { success: false, error: "invalid_json", raw: text };
    }

    if (response.ok && (data.token || data.session_token)) {
      const token = data.token || data.session_token;
      const cValue = payload.get('c');
      
      console.log(chalk.green(`[arkose] ✅ Arkose Public Key 요청 성공!`));
      console.log(chalk.green(`[arkose] ----------------------------------------`));
      console.log(chalk.green(`[arkose] c= 값 (blob):`));
      console.log(chalk.blue(`${cValue.substring(0, 80)}... (전체 길이: ${cValue.length}자)`));
      console.log(chalk.green(`[arkose] 세션 토큰:`));
      console.log(chalk.blue(`${token}`));
      console.log(chalk.green(`[arkose] ----------------------------------------`));
      
      return {
        success: true,
        cValue: cValue,
        sessionToken: token,
        rawResponse: data
      };
    } else {
      console.log(chalk.red(`[arkose] ❌ Public Key 획득 실패 (상태: ${response.status})`));
      return { success: false, status: response.status, data: data };
    }
  } catch (error) {
    console.error(chalk.red(`[arkose] ❌ Public Key 요청 중 예외 발생: ${error.message}`));
    return { success: false, error: error.message };
  }
}
