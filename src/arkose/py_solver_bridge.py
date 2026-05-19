import sys
import json
import requests
try:
    from py_arkose_generator.arkose import get_values_for_request
except ImportError:
    print("Error: py_arkose_generator not installed. Run 'pip install py-arkose-generator'")
    sys.exit(1)

def solve(pkey, blob=None):
    opt = {
        "pkey": pkey,
        "surl": "https://a-cdn.claude.ai",
        "site": "https://claude.ai",
        "headers": {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
        }
    }
    
    # get_values_for_request handles the generation of 'bda' and other parameters
    args = get_values_for_request(opt)
    
    # If blob (c=) is provided, it should be added to the data payload
    if blob:
        # Some versions of Arkose expect the blob inside the 'data' field of the POST body
        if 'data' not in args:
            args['data'] = {}
        args['data']['blob'] = blob

    try:
        response = requests.post(**args, timeout=30)
        if response.ok:
            data = response.json()
            if "token" in data:
                return data["token"]
            else:
                return f"Error: No token in response. {json.dumps(data)}"
        else:
            return f"Error: Request failed with status {response.status_code}. {response.text}"
    except Exception as e:
        return f"Error: {str(e)}"

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python py_solver_bridge.py <public_key> [blob]")
        sys.exit(1)
        
    pk = sys.argv[1]
    bl = sys.argv[2] if len(sys.argv) > 2 else None
    
    result = solve(pk, bl)
    print(result)
