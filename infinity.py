import requests
import time

target = "https://chaosnet.onrender.com/login.html"


while True:
    try:
        r = requests.get(target)
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Статус-код: {r.status_code}")
    except Exception as e:
        print(f"[{time.strftime('%Y-%m-%d %H:%M:%S')}] Ошибка: {e}")
    
    time.sleep(600)