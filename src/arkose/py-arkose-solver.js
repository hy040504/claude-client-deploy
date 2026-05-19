import { spawn } from 'node:child_process';
import chalk from "chalk";

/**
 * py-arkose-token-generator를 사용해 Arkose Token 생성
 * @param {string} blob - Arkose blob (c= 값)
 * @param {string} publicKey - Arkose Public Key
 * @returns {Promise<string>} Arkose Token
 */
export async function solveWithPyArkose(blob, publicKey = "EEA5F558-D6AC-4C03-B678-AABF639EE69A") {
  if (!blob) {
    console.log(chalk.yellow("[py-arkose] ⚠️ blob이 없습니다."));
    return null;
  }

  console.log(chalk.cyan(`[py-arkose] Solver 시작 | blob: ${blob.slice(0, 80)}...`));

  return new Promise((resolve) => {
    // Windows 환경 고려하여 'python' 우선 시도
    const pythonProcess = spawn('python', [
      '-c',
      `
import json
import sys
import requests
try:
    from py_arkose_generator.arkose import get_values_for_request
except ImportError:
    print(json.dumps({"success": False, "error": "ImportError: py_arkose_generator not installed"}))
    sys.exit(0)

opt = {
    "pkey": "${publicKey}",
    "surl": "https://a-cdn.claude.ai",
    "site": "https://claude.ai",
    "headers": {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36"
    }
}

try:
    # get_values_for_request 호출하여 기본 인자 생성
    args = get_values_for_request(opt)
    
    # args['data']가 문자열(form-encoded 등)일 경우 blob을 안전하게 추가
    blob_val = "${blob}"
    if isinstance(args.get('data'), str):
        if args['data']:
            args['data'] += f"&blob={blob_val}"
        else:
            args['data'] = f"blob={blob_val}"
    elif isinstance(args.get('data'), dict):
        args['data']['blob'] = blob_val
    else:
        # data가 없으면 dict로 생성
        args['data'] = {"blob": blob_val}
        
    # 실제 요청 수행하여 토큰 획득
    response = requests.post(**args, timeout=30)
    if response.ok:
        data = response.json()
        if "token" in data:
            print(json.dumps({"success": True, "token": data["token"]}))
        else:
            print(json.dumps({"success": False, "error": f"No token in response: {json.dumps(data)}"}))
    else:
        print(json.dumps({"success": False, "error": f"HTTP {response.status_code}: {response.text[:200]}"}))
except Exception as e:
    print(json.dumps({"success": False, "error": str(e)}))
      `
    ]);

    let output = '';
    pythonProcess.stdout.on('data', (data) => { output += data; });
    pythonProcess.stderr.on('data', (data) => { 
        const errStr = data.toString();
        if (errStr.trim() && !errStr.includes("Debugger warning")) {
            console.error(chalk.red(`[py-arkose] stderr: ${errStr}`)); 
        }
    });

    pythonProcess.on('close', (code) => {
      if (code !== 0) {
        console.error(chalk.red(`[py-arkose] Python 프로세스 종료 코드: ${code}`));
        resolve(`dummy-py-arkose-error-${Date.now()}`);
        return;
      }

      try {
        const result = JSON.parse(output.trim());
        if (result.success && result.token) {
          console.log(chalk.green(`[py-arkose] ✅ Arkose Token 생성 성공!`));
          resolve(result.token);
        } else {
          console.error(chalk.red(`[py-arkose] 실패: ${result.error}`));
          resolve(`dummy-py-arkose-fail-${Date.now()}`);
        }
      } catch (e) {
        console.error(chalk.red(`[py-arkose] JSON 파싱 실패: ${output}`));
        resolve(`dummy-py-arkose-json-error-${Date.now()}`);
      }
    });
  });
}
