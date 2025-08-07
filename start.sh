#!/bin/bash

# Запускаем infinity.py в фоне
python3 infinity.py &

# Запускаем Node.js сервер
node server.js