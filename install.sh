#!/bin/bash
set -e

echo "=== Установка зависимостей ==="
apt update -y
apt install -y curl nginx python3 python3-venv

# Удаление старых версий Node.js если есть
apt remove -y nodejs npm 2>/dev/null || true

# Установка Node.js 22.x
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs

# Обновление npm до конкретной версии
npm install -g npm@11.6.4
npm install -g pm2

echo "=== Создание Python venv ==="
# Создаем директорию если не существует
mkdir -p /root/app
cd /root/app

# Устанавливаем пакет для venv если нужно
apt install -y python3.12-venv || apt install -y python3-venv

# Создаем venv
python3 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install fastapi uvicorn[standard] python-multipart

# Создаем директорию для логов
mkdir -p logs

echo "=== Создание ecosystem.config.js ==="
cat > /root/app/ecosystem.config.js << 'EOF'
module.exports = {
  apps: [{
    name: 'test-app',
    script: './venv/bin/python',
    args: '-m uvicorn main:app --host 0.0.0.0 --port 8000 --reload',
    cwd: '/root/app',
    watch: true,
    autorestart: true,
    env: { NODE_ENV: 'development' }
  }]
};
EOF

echo "=== Запуск приложения через PM2 ==="
pm2 delete test-app 2>/dev/null || true
pm2 start /root/app/ecosystem.config.js
pm2 save
pm2 startup 2>/dev/null || true

echo "=== Настройка Nginx ==="
# Создаем директорию sites-available если не существует
mkdir -p /etc/nginx/sites-available
mkdir -p /etc/nginx/sites-enabled

# Удаляем default конфиг если существует
rm -f /etc/nginx/sites-enabled/default

# Создаем новый конфиг
cat > /etc/nginx/sites-available/default << 'EOF'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    
    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # Для статических файлов FastAPI
        proxy_set_header X-Forwarded-Host $server_name;
    }
    
    # Отключаем логи для favicon.ico
    location = /favicon.ico {
        access_log off;
        log_not_found off;
    }
}
EOF

# Активируем конфиг
ln -sf /etc/nginx/sites-available/default /etc/nginx/sites-enabled/

# Проверяем конфигурацию nginx
nginx -t

# Создаем директорию static если не существует
mkdir -p /root/app/static

# Устанавливаем правильные права
chmod 755 /root
chmod 755 /root/app
chmod 755 /root/app/static 2>/dev/null || true
chown -R www-data:www-data /root/app/static 2>/dev/null || true
find /root/app/static -type f -exec chmod 644 {} \; 2>/dev/null || true

# Перезапускаем nginx
systemctl restart nginx

# Включаем автозагрузку nginx
systemctl enable nginx 2>/dev/null || true

echo "=== Проверка ==="
echo "1. Статус PM2:"
pm2 status

echo -e "\n2. Статус Nginx:"
systemctl status nginx --no-pager

echo -e "\n3. Проверка портов:"
netstat -tulpn | grep -E ':80|:8000' || ss -tulpn | grep -E ':80|:8000' || echo "Используйте: netstat -tulpn или ss -tulpn"

echo -e "\n4. Текущий IP:"
# Пробуем разные способы получения IP
PUBLIC_IP=$(curl -s --connect-timeout 3 http://ifconfig.me 2>/dev/null || \
            curl -s --connect-timeout 3 http://icanhazip.com 2>/dev/null || \
            hostname -I 2>/dev/null | awk '{print $1}' || \
            ip addr show 2>/dev/null | grep -oP '(?<=inet\s)\d+(\.\d+){3}' | grep -v '127.0.0.1' | head -1 || \
            echo "не удалось определить")

echo "IP адрес: $PUBLIC_IP"

echo -e "\n=== ГОТОВО ==="
echo "Приложение должно быть доступно по адресу:"
echo "http://$PUBLIC_IP"
echo "http://localhost:8000"

echo -e "\nДля проверки работы FastAPI:"
echo "curl http://localhost:8000"
echo "или"
echo "curl http://$PUBLIC_IP"

echo -e "\nЛоги приложения:"
echo "pm2 logs test-app"
echo "pm2 monit"

echo -e "\nЛоги Nginx:"
echo "tail -f /var/log/nginx/access.log"
echo "tail -f /var/log/nginx/error.log"