(() => {
    const DEBUG = true;
    const log = (...args) => DEBUG && console.log("%c[DICE]", "color:#9c6", ...args);
    const warn = (...args) => DEBUG && console.warn("%c[DICE]", "color:#c96", ...args);

    const wsUrl = () => {
        const loc = window.location;
        const protocol = loc.protocol === "https:" ? "wss:" : "ws:";
        const roomCode = getRoomCodeFromPath();
        return `${protocol}//${loc.host}/ws/${roomCode}`;
    };

    function getRoomCodeFromPath() {
        const parts = window.location.pathname.split("/").filter(Boolean);
        const idx = parts.indexOf("room");
        return idx >= 0 && parts[idx + 1] ? parts[idx + 1] : "";
    }

    const nicknameKey = "dice_table_nickname";
    let nickname = localStorage.getItem(nicknameKey) || "";
    let socket = null;
    let isRolling = false;
    let manualClose = false;
    let activeDice = [];
    
    let currentPlayer = "";
    let playersOrder = [];
    let isTurnBased = true;
    let players = [];

    // Модальные окна
    const modeSelectionModal = document.getElementById("mode-selection-modal");
    const onlineModal = document.getElementById("online-modal");
    const nicknameInput = document.getElementById("nickname-input");
    const roomCodeInput = document.getElementById("room-code-input");
    const modeSingleBtn = document.getElementById("mode-single");
    const modeOnlineBtn = document.getElementById("mode-online");
    const createRoomBtn = document.getElementById("create-room-btn");
    const joinRoomBtn = document.getElementById("join-room-btn");
    
    let gameMode = null;
    const diceTypeSelect = document.getElementById("dice-type");
    const customSidesWrapper = document.getElementById("custom-sides-wrapper");
    const customSidesInput = document.getElementById("custom-sides");
    const quantityInput = document.getElementById("dice-quantity");
    const rollButton = document.getElementById("roll-button");
    const inviteButton = document.getElementById("invite-players");
    const leaveButton = document.getElementById("leave-room");
    const historyList = document.getElementById("history-list");
    const diceResultText = document.getElementById("dice-result");
    const diceSound = document.getElementById("dice-sound");
    const muteButton = document.getElementById("mute-button");
    
    const modeFreeBtn = document.getElementById('mode-free');
    const modeTurnBtn = document.getElementById('mode-turn');
    const currentPlayerName = document.getElementById('current-player-name');
    const playersOrderSpan = document.getElementById('players-order');

    let isMuted = false;
    const savedMuteState = localStorage.getItem('dice_table_muted');
    if (savedMuteState === 'true') {
        isMuted = true;
        muteButton.classList.add('muted');
        muteButton.querySelector('.mute-icon').textContent = '🔇';
    }
    
    muteButton.addEventListener('click', () => {
        isMuted = !isMuted;
        if (isMuted) {
            muteButton.classList.add('muted');
            muteButton.querySelector('.mute-icon').textContent = '🔇';
            muteButton.title = 'Включить звук';
        } else {
            muteButton.classList.remove('muted');
            muteButton.querySelector('.mute-icon').textContent = '🔊';
            muteButton.title = 'Выключить звук';
        }
        localStorage.setItem('dice_table_muted', isMuted.toString());
    });
    
    function playDiceSound() {
        if (isMuted) return;
        
        if (diceSound.src && diceSound.src !== location.href) {
            diceSound.currentTime = 0;
            diceSound.play().catch(() => generateDiceSound());
        } else {
            generateDiceSound();
        }
    }

    function generateDiceSound() {
        try {
            const ctx = new (window.AudioContext || window.webkitAudioContext)();
            const dur = 0.3;
            const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate);
            const data = buf.getChannelData(0);
            for (let i = 0; i < data.length; i++) {
                const t = i / ctx.sampleRate;
                data[i] = (Math.random() * 2 - 1) * Math.exp(-t * 8) * 0.3;
            }
            const src = ctx.createBufferSource();
            src.buffer = buf;
            src.connect(ctx.destination);
            src.start(0);
        } catch (e) {}
    }

    function showModeSelection() {
        modeSelectionModal.style.display = "flex";
    }
    modeSingleBtn.addEventListener("click", () => {
        gameMode = "single";
        nickname = "";
        modeSelectionModal.style.display = "none";
        inviteButton.style.display = "inline-block";
        connectWebSocket();
    });
    modeOnlineBtn.addEventListener("click", () => {
        gameMode = "online";
        modeSelectionModal.style.display = "none";
        onlineModal.style.display = "flex";
        
        if (nickname) {
            nicknameInput.value = nickname;
        }
        nicknameInput.focus();
        
        const roomCode = getRoomCodeFromPath();
        if (roomCode) {
            roomCodeInput.value = roomCode;
            updateJoinButton();
        }
    });
    function updateJoinButton() {
        const code = roomCodeInput.value.trim();
        if (code) {
            joinRoomBtn.style.display = "block";
            joinRoomBtn.classList.add("available");
            joinRoomBtn.disabled = false;
        } else {
            joinRoomBtn.style.display = "none";
            joinRoomBtn.classList.remove("available");
        }
    }

    roomCodeInput.addEventListener("input", updateJoinButton);
    createRoomBtn.addEventListener("click", () => {
        const val = nicknameInput.value.trim();
        if (!val) {
            showError("Введите ваш ник");
            return;
        }
        nickname = val;
        localStorage.setItem(nicknameKey, nickname);
        gameMode = "online";
        const newCode = generateRoomCode();
        window.location.href = `/room/${newCode}`;
    });
    joinRoomBtn.addEventListener("click", () => {
        const val = nicknameInput.value.trim();
        let code = roomCodeInput.value.trim();
        
        if (!code) {
            code = getRoomCodeFromPath();
        }
        
        if (!val) {
            showError("Введите ваш ник");
            return;
        }
        if (!code) {
            showError("Введите код комнаты");
            return;
        }
        nickname = val;
        localStorage.setItem(nicknameKey, nickname);
        gameMode = "online";
        
        const currentRoomCode = getRoomCodeFromPath();
        if (currentRoomCode === code) {
            onlineModal.style.display = "none";
            connectWebSocket();
        } else {
            window.location.href = `/room/${code}`;
        }
    });

    nicknameInput.addEventListener("keydown", e => {
        if (e.key === "Enter") {
            const code = roomCodeInput.value.trim();
            if (code) {
                joinRoomBtn.click();
            } else {
                createRoomBtn.click();
            }
        }
    });

    function generateRoomCode(length = 6) {
        const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
        return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
    }

    diceTypeSelect.addEventListener("change", () => {
        customSidesWrapper.style.display = diceTypeSelect.value === "custom" ? "inline-flex" : "none";
    });

    rollButton.addEventListener("click", () => {
        if (gameMode === "single" && (!socket || socket.readyState !== WebSocket.OPEN)) {
            const quantity = Math.min(parseInt(quantityInput.value || "1", 10), 10);
            const diceType = diceTypeSelect.value;
            const customSides = parseInt(customSidesInput.value || "0", 10);
            
            let sides = 6;
            if (diceType === "custom" && customSides > 1) {
                sides = customSides;
            } else {
                try {
                    sides = parseInt(diceType.replace(/^[dD]+/, ""));
                } catch {
                    sides = 6;
                }
            }
            
            const rolls = Array.from({ length: quantity }, () => Math.floor(Math.random() * sides) + 1);
            const total = rolls.reduce((a, b) => a + b, 0);
            const notation = `${quantity}d${sides}`;
            
            handleDiceRollAnimation({
                nickname: nickname || "Игрок",
                quantity: quantity,
                dice_notation: notation
            });
            
            setTimeout(() => {
                handleDiceResult({
                    nickname: nickname || "Игрок",
                    dice_notation: notation,
                    rolls: rolls,
                    total: total
                });
            }, 1000);
            return;
        }
        
        if (!socket || socket.readyState !== WebSocket.OPEN) {
            warn("Roll attempt without open socket");
            return;
        }
        
        if (isTurnBased && currentPlayer !== nickname) {
            showError(`Сейчас ход игрока ${currentPlayer}. Дождитесь своей очереди.`);
            return;
        }
        
        const payload = {
            type: "dice_roll",
            dice_type: diceTypeSelect.value,
            quantity: parseInt(quantityInput.value || "1", 10),
            custom_sides: parseInt(customSidesInput.value || "0", 10),
        };
        log("→ roll", payload);
        socket.send(JSON.stringify(payload));
    });

    inviteButton.addEventListener("click", () => {
        let roomCode = getRoomCodeFromPath();
        let url = window.location.href;
        
        if (gameMode === "single" && !roomCode) {
            roomCode = generateRoomCode();
            url = `${window.location.origin}/room/${roomCode}`;
            window.location.href = url;
            return;
        }
        
        navigator.clipboard.writeText(url).then(() => {
            showError(`Ссылка на комнату скопирована: ${roomCode}`);
        }).catch(err => {
            prompt("Скопируйте эту ссылку и отправьте друзьям:", url);
        });
    });

    function connectWebSocket() {
        if (gameMode === "single" && !getRoomCodeFromPath()) {
            nickname = nickname || "Игрок";
            updateSeats([nickname]);
            onlineModal.style.display = "none";
            updateInviteButton();
            currentPlayer = nickname;
            playersOrder = [nickname];
            updateTurnOrder({ players_order: [nickname], current_player: nickname, is_turn_based: false });
            return;
        }
        
        manualClose = false;
        const url = wsUrl();
        log("Connecting to", url);
        socket = new WebSocket(url);

        socket.addEventListener("open", () => {
            log("WS open → send join");
            const joinNickname = gameMode === "single" ? (nickname || "Игрок") : nickname;
            socket.send(JSON.stringify({ type: "join", nickname: joinNickname }));
        });

        socket.addEventListener("message", event => {
            let data;
            try {
                data = JSON.parse(event.data);
                log("← msg", data);
            } catch (e) {
                warn("Not JSON:", event.data);
                return;
            }

            switch (data.type) {
                case "player_joined":
                    updateSeats(data.players);
                    if (data.nickname && gameMode === "single") {
                        nickname = data.nickname;
                    }
                    updateTurnOrder(data);
                    addSystemMessage(`${data.nickname} присоединился к столу`);
                    updateInviteButton();
                    break;
                case "player_left":
                    updateSeats(data.players);
                    updateTurnOrder(data);
                    addSystemMessage(`${data.nickname} покинул стол`);
                    updateInviteButton();
                    break;
                case "dice_roll":
                    handleDiceRollAnimation(data);
                    break;
                case "dice_result":
                    handleDiceResult(data);
                    break;
                case "turn_update":
                    log("Received turn_update:", data);
                    updateTurnOrder(data);
                    break;
                case "error":
                    showError(data.message);
                    break;
            }
        });

        socket.addEventListener("close", ev => {
            log("WS closed", ev.code, ev.reason, "manual:", manualClose);
            if (!manualClose) {
                addSystemMessage("Соединение потеряно. Переподключение...");
                setTimeout(() => {
                    if (!manualClose) {
                        connectWebSocket();
                    }
                }, 1500);
            }
        });

        socket.addEventListener("error", err => warn("WS error", err));
    }

    function updateSeats(playersList) {
        players = playersList || [];
        const seats = document.querySelectorAll(".player-seat");
        const totalSeats = seats.length;
        
        seats.forEach(seat => {
            seat.querySelector(".nickname").textContent = "Пусто";
            seat.classList.remove("me", "active", "current-turn");
            seat.style.display = "none";
        });
        
        const playerCount = players.length;
        updateInviteButton();
        const positions = calculatePositions(playerCount, totalSeats);
        
        players.forEach((name, index) => {
            const positionIndex = positions[index];
            if (positionIndex >= 0 && positionIndex < totalSeats) {
                const seat = seats[positionIndex];
                seat.style.display = "block";
                seat.querySelector(".nickname").textContent = name;
                if (name === nickname) {
                    seat.classList.add("me");
                }
                if (name === currentPlayer) {
                    seat.classList.add("current-turn");
                }
                seat.classList.add("active");
            }
        });
    }
    
    function calculatePositions(playerCount, totalSeats) {
        const positions = [];
        
        if (playerCount === 1) {
            positions.push(0);
        } else if (playerCount === 2) {
            positions.push(0);
            positions.push(6);
        } else if (playerCount === 3) {
            positions.push(0);
            positions.push(4);
            positions.push(8);
        } else {
            for (let i = 0; i < playerCount; i++) {
                const hourAngle = (i / playerCount) * 12;
                let seatIndex = Math.round(hourAngle) % 12;
                
                if (playerCount === 4) {
                    seatIndex = (i * 3) % 12;
                }
                
                positions.push(seatIndex);
            }
        }
        
        return positions;
    }
    function updateTurnOrder(data) {
        playersOrder = data.players_order || [];
        currentPlayer = data.current_player || "";
        isTurnBased = data.is_turn_based !== false;
        
        log("Update turn order:", { playersOrder, currentPlayer, isTurnBased, nickname });
        
        document.querySelectorAll('.player-seat').forEach(seat => {
            const seatNickname = seat.querySelector('.nickname').textContent;
            seat.classList.remove('current-turn');
            
            if (seatNickname === currentPlayer) {
                seat.classList.add('current-turn');
            }
        });
        
        currentPlayerName.textContent = currentPlayer || "—";
        playersOrderSpan.textContent = playersOrder.join(", ") || "—";
        
        modeFreeBtn.classList.toggle('active', !isTurnBased);
        modeTurnBtn.classList.toggle('active', isTurnBased);
        
        updateRollButtonState();
    }

    function updateRollButtonState() {
        const myTurn = currentPlayer === nickname;
        const canRoll = !isTurnBased || myTurn;
        
        rollButton.disabled = !canRoll;
        
        if (canRoll) {
            rollButton.textContent = isTurnBased && myTurn ? "Ваш ход! Бросить" : "Бросить!";
        } else {
            rollButton.textContent = `Ход: ${currentPlayer || "..."}`;
        }
        
        if (isTurnBased && !myTurn) {
            rollButton.title = `Сейчас ход игрока ${currentPlayer}`;
        } else {
            rollButton.title = "";
        }
    }

    function showError(message) {
        const el = document.createElement("div");
        el.className = "history-item error";
        el.textContent = `⚠ ${message}`;
        historyList.appendChild(el);
        trimHistory();
        historyList.scrollTop = historyList.scrollHeight;
    }
    
    function updateInviteButton() {
        if (gameMode === "single") {
            inviteButton.style.display = "inline-block";
            return;
        }
        if (players.length < 2 && nickname) {
            inviteButton.style.display = "inline-block";
        } else {
            inviteButton.style.display = "none";
        }
    }
    modeFreeBtn.addEventListener('click', () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        
        modeFreeBtn.classList.add('active');
        modeTurnBtn.classList.remove('active');
        
        socket.send(JSON.stringify({
            type: "change_mode",
            turn_based: false
        }));
    });
    
    modeTurnBtn.addEventListener('click', () => {
        if (!socket || socket.readyState !== WebSocket.OPEN) return;
        
        modeFreeBtn.classList.remove('active');
        modeTurnBtn.classList.add('active');
        
        socket.send(JSON.stringify({
            type: "change_mode",
            turn_based: true
        }));
    });

    function addSystemMessage(text) {
        const el = document.createElement("div");
        el.className = "history-item";
        el.textContent = text;
        historyList.appendChild(el);
        trimHistory();
        historyList.scrollTop = historyList.scrollHeight;
    }

    function formatRolls(r) { return r.join(" + "); }

    function trimHistory(max = 15) {
        while (historyList.children.length > max) historyList.removeChild(historyList.firstChild);
    }

    function handleDiceRollAnimation(data) {
        playDiceSound();
        isRolling = true;
        diceResultText.textContent = "";
        activeDice = [];
        rollButton.style.opacity = "0.5";
        rollButton.style.pointerEvents = "none";
        
        const { nickname: who, quantity, dice_notation, sides } = data;
        const diceCount = Math.min(quantity || 1, 10);
        const isD6 = sides === 6 || dice_notation === "d6" || dice_notation?.toLowerCase().includes("d6");
        
        const table = document.querySelector(".poker-table");
        if (!table) {
            log("Table not found in handleDiceRollAnimation!");
            return;
        }
        const tableRect = table.getBoundingClientRect();
        const centerStart = {
            x: tableRect.width / 2,
            y: tableRect.height / 2
        };
        for (let i = 0; i < diceCount; i++) {
            setTimeout(() => {
                const diceElement = createDiceAnimation(centerStart, isD6);
                if (diceElement) {
                    activeDice.push(diceElement);
                }
            }, i * 50);
        }
    }
    
    function create3DDice() {
        const cube = document.createElement("div");
        cube.className = "dice-3d-cube";
        
        const faces = [
            { value: 1, dots: [[0.5, 0.5]] },
            { value: 2, dots: [[0.25, 0.25], [0.75, 0.75]] },
            { value: 3, dots: [[0.25, 0.25], [0.5, 0.5], [0.75, 0.75]] },
            { value: 4, dots: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]] },
            { value: 5, dots: [[0.25, 0.25], [0.75, 0.25], [0.5, 0.5], [0.25, 0.75], [0.75, 0.75]] },
            { value: 6, dots: [[0.25, 0.25], [0.75, 0.25], [0.25, 0.5], [0.75, 0.5], [0.25, 0.75], [0.75, 0.75]] }
        ];
        
        faces.forEach((face, index) => {
            const faceEl = document.createElement("div");
            faceEl.className = `dice-face dice-face-${index + 1}`;
            
            face.dots.forEach(dot => {
                const dotEl = document.createElement("div");
                dotEl.className = "dice-dot";
                dotEl.style.left = `${dot[0] * 100}%`;
                dotEl.style.top = `${dot[1] * 100}%`;
                faceEl.appendChild(dotEl);
            });
            
            cube.appendChild(faceEl);
        });
        
        return cube;
    }
    
    function createDiceAnimation(startPos, isD6 = false) {
        const table = document.querySelector(".poker-table");
        if (!table) {
            log("Table not found!");
            return null;
        }
        
        const dice = document.createElement("div");
        dice.className = "flying-dice-3d";
        
        const diceCube = create3DDice();
        dice.appendChild(diceCube);
        table.appendChild(dice);
        
        dice._diceCube = diceCube;
        dice._isD6 = isD6;
        
        dice.style.left = `${startPos.x - 36}px`;
        dice.style.top = `${startPos.y - 36}px`;
        
        const rollAngle = Math.random() * Math.PI * 2;
        const rollDistance = 40 + Math.random() * 60;
        const throwHeight = 30 + Math.random() * 40;
        const rotateX = Math.random() * 720;
        const rotateY = Math.random() * 720;
        const rotateZ = Math.random() * 720;
        
        const keyframes = [];
        const steps = 40;
        
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const horizontalProgress = 1 - Math.pow(1 - t, 2);
            const rollX = Math.cos(rollAngle) * rollDistance * horizontalProgress;
            const rollY = Math.sin(rollAngle) * rollDistance * horizontalProgress;
            
            let verticalOffset = 0;
            if (t < 0.5) {
                const upProgress = t * 2;
                verticalOffset = -throwHeight * (1 - Math.pow(1 - upProgress, 2));
            } else {
                const downProgress = (t - 0.5) * 2;
                verticalOffset = -throwHeight + throwHeight * Math.pow(downProgress, 2);
            }
            
            const randomOffsetX = (Math.random() - 0.5) * 15;
            const randomOffsetY = (Math.random() - 0.5) * 15;
            
            const finalX = startPos.x + rollX + randomOffsetX;
            const finalY = startPos.y + rollY + verticalOffset + randomOffsetY;
            
            keyframes.push({
                left: `${finalX - 36}px`,
                top: `${finalY - 36}px`,
                opacity: 1
            });
        }
        
        const duration = 1000 + Math.random() * 500;
        
        const animation = dice.animate(keyframes, {
            duration: duration,
            easing: "ease-out",
            fill: "forwards"
        });
        
        const totalRotation = 1440 + Math.random() * 720;
        const finalRotateX = rotateX + totalRotation;
        const finalRotateY = rotateY + totalRotation;
        const finalRotateZ = rotateZ + totalRotation;
        
        dice._finalRotateX = finalRotateX;
        dice._finalRotateY = finalRotateY;
        dice._finalRotateZ = finalRotateZ;
        
        diceCube.animate([
            { transform: `rotateX(${rotateX}deg) rotateY(${rotateY}deg) rotateZ(${rotateZ}deg)` },
            { transform: `rotateX(${finalRotateX}deg) rotateY(${finalRotateY}deg) rotateZ(${finalRotateZ}deg)` }
        ], {
            duration: duration,
            easing: "linear",
            fill: "forwards"
        });
        
        animation.onfinish = () => {
            if (!isD6) {
                dice.remove();
            }
        };
        
        return dice;
    }
    
    function stopDiceOnFace(diceElement, faceValue) {
        if (!diceElement || !diceElement._isD6 || !diceElement._diceCube) {
            return;
        }
        
        const cube = diceElement._diceCube;
        const currentRotateX = diceElement._finalRotateX || 0;
        const currentRotateY = diceElement._finalRotateY || 0;
        const currentRotateZ = diceElement._finalRotateZ || 0;
        
        let targetRotateX = 0;
        let targetRotateY = 0;
        let targetRotateZ = 0;
        
        const isoAngle = 45;
        switch(faceValue) {
            case 1:
                targetRotateX = -isoAngle;
                targetRotateY = 0;
                targetRotateZ = 0;
                break;
            case 2:
                targetRotateX = isoAngle;
                targetRotateY = 180;
                targetRotateZ = 0;
                break;
            case 3:
                targetRotateX = isoAngle - 90;
                targetRotateY = 0;
                targetRotateZ = 0;
                break;
            case 4:
                targetRotateX = 90 + isoAngle;
                targetRotateY = 180;
                targetRotateZ = 0;
                break;
            case 5:
                targetRotateX = -isoAngle;
                targetRotateY = -90;
                targetRotateZ = 0;
                break;
            case 6:
                targetRotateX = -isoAngle;
                targetRotateY = 90;
                targetRotateZ = 0;
                break;
        }
        
        log(`Stopping dice on face ${faceValue} with angles: X=${targetRotateX}, Y=${targetRotateY}, Z=${targetRotateZ}. Current angles: X=${currentRotateX}, Y=${currentRotateY}, Z=${currentRotateZ}`);
        
        const stopAnimation = cube.animate([
            { 
                transform: `rotateX(${currentRotateX}deg) rotateY(${currentRotateY}deg) rotateZ(${currentRotateZ}deg)` 
            },
            { 
                transform: `rotateX(${targetRotateX}deg) rotateY(${targetRotateY}deg) rotateZ(${targetRotateZ}deg)` 
            }
        ], {
            duration: 400,
            easing: "ease-out",
            fill: "forwards"
        });
        
        stopAnimation.onfinish = () => {
            setTimeout(() => {
                if (diceElement.parentNode) {
                    diceElement.remove();
                }
            }, 1000);
        };
    }

    function handleDiceResult(data) {
        isRolling = false;
        const { nickname: who, dice_notation, rolls, total, sides } = data;
        const rollsStr = formatRolls(rolls);
        diceResultText.textContent = `${who} бросил ${dice_notation}: ${rollsStr} = ${total}`;

        const item = document.createElement("div");
        item.className = "history-item";
        item.innerHTML = `<span class="nickname">[${who}]</span> бросил <span class="notation">${dice_notation}</span> → ${rollsStr} = <span class="total">${total}</span>`;
        historyList.appendChild(item);
        trimHistory();
        historyList.scrollTop = historyList.scrollHeight;
        
        const isD6 = sides === 6 || dice_notation === "d6" || dice_notation?.toLowerCase().includes("d6");
        if (isD6 && activeDice.length > 0 && rolls && rolls.length > 0) {
            const waitTime = 1200;
            setTimeout(() => {
                log(`Stopping ${activeDice.length} dice with rolls:`, rolls);
                activeDice.forEach((diceElement, index) => {
                    if (diceElement && diceElement.parentNode && rolls[index]) {
                        log(`Stopping dice ${index} on face value:`, rolls[index]);
                        stopDiceOnFace(diceElement, rolls[index]);
                    } else if (diceElement && diceElement.parentNode) {
                        diceElement.remove();
                    }
                });
                activeDice = [];
            }, waitTime);
        } else {
            setTimeout(() => {
                activeDice.forEach(diceElement => {
                    if (diceElement && diceElement.parentNode) {
                        diceElement.remove();
                    }
                });
                activeDice = [];
            }, 1500);
        }
        
        rollButton.style.opacity = "1";
        rollButton.style.pointerEvents = "auto";
        updateRollButtonState();
    }

    leaveButton.addEventListener("click", () => {
        manualClose = true;
        if (socket && socket.readyState === WebSocket.OPEN) socket.close(1000, "Leave room");
        localStorage.removeItem(nicknameKey);
        nickname = "";
        gameMode = null;
        location.href = "/room";
    });

    function initializeOnLoad() {
        const roomCode = getRoomCodeFromPath();
        const savedNickname = localStorage.getItem(nicknameKey);
        const hasValidNickname = savedNickname && savedNickname.trim();
        
        if (roomCode && hasValidNickname) {
            nickname = savedNickname.trim();
            gameMode = "online";
            onlineModal.style.display = "none";
            modeSelectionModal.style.display = "none";
            connectWebSocket();
        } else {
            showModeSelection();
        }
    }

    initializeOnLoad();

    const authorsBtn = document.querySelector('.authors-btn');
    const authorsModal = document.querySelector('.authors-modal');
    const authorsClose = document.querySelector('.authors-close');

    if (authorsBtn && authorsModal && authorsClose) {
        authorsBtn.addEventListener('click', () => {
            authorsModal.classList.add('active');
            document.body.style.overflow = 'hidden';
        });

        authorsClose.addEventListener('click', () => {
            authorsModal.classList.remove('active');
            document.body.style.overflow = '';
        });

        authorsModal.addEventListener('click', (e) => {
            if (e.target === authorsModal) {
                authorsModal.classList.remove('active');
                document.body.style.overflow = '';
            }
        });
    }
})();