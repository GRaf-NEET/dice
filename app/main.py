import asyncio
import random
import string
from typing import Dict, List, Optional, Set

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
import logging
import itertools
from typing import Optional

from config import DEBUG

# Логгер
logging.basicConfig(
    level=logging.DEBUG if DEBUG else logging.INFO,
    format="[%(asctime)s] %(levelname)-8s %(name)s — %(message)s",
)
logger = logging.getLogger("dice_table")
logger.setLevel(logging.DEBUG if DEBUG else logging.INFO)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class Room:
    def __init__(self, code: str):
        self.code = code
        self.connections: Set[WebSocket] = set()
        self.players: Dict[WebSocket, str] = {}
        self.history: List[dict] = []
        self.cleanup_task: Optional[asyncio.Task] = None
        self.turn_order: List[WebSocket] = []  # Порядок ходов
        self.current_turn_index: int = 0  # Индекс текущего игрока
        self.is_turn_based: bool = True  # Режим по очереди (True) или свободный (False)
        logger.debug(f"Room created: {code}")

    def add_connection(self, ws: WebSocket, nickname: str):
        self.connections.add(ws)
        self.players[ws] = nickname

        if ws not in self.turn_order:
            self.turn_order.append(ws)
            logger.debug(f"[{self.code}] {nickname} added to turn order at position {len(self.turn_order)}")
        logger.debug(f"[{self.code}] + {nickname} (total {len(self.players)})")

    def remove_connection(self, ws: WebSocket):
        nick = self.players.get(ws)
        self.connections.discard(ws)
        self.players.pop(ws, None)
        if ws in self.turn_order:
            idx = self.turn_order.index(ws)
            self.turn_order.remove(ws)
            # Корректируем текущий индекс, если удаляем игрока перед текущим
            if idx < self.current_turn_index:
                self.current_turn_index -= 1
            elif idx == self.current_turn_index and self.turn_order:
                # Если удалили текущего игрока, ход переходит к следующему
                self.current_turn_index %= len(self.turn_order)
            # Если очередь пуста, сбрасываем индекс
            if not self.turn_order:
                self.current_turn_index = 0
        if nick:
            logger.debug(f"[{self.code}] - {nick} (left {len(self.players)})")

    def is_empty(self) -> bool:
        return len(self.connections) == 0

    def get_current_player(self) -> Optional[WebSocket]:
        """Получить WebSocket текущего игрока"""
        if self.turn_order and self.current_turn_index < len(self.turn_order):
            return self.turn_order[self.current_turn_index]
        return None

    def next_turn(self):
        """Передать ход следующему игроку"""
        if self.turn_order:
            self.current_turn_index = (self.current_turn_index + 1) % len(self.turn_order)
            logger.debug(f"[{self.code}] Turn passed to {self.players.get(self.get_current_player(), 'Unknown')}")

    def get_players_order(self) -> List[str]:
        """Получить список игроков в порядке хода"""
        return [self.players[ws] for ws in self.turn_order if ws in self.players]

    def get_current_player_nickname(self) -> str:
        """Получить ник текущего игрока"""
        current = self.get_current_player()
        return self.players.get(current, "") if current else ""

rooms: Dict[str, Room] = {}
rooms_lock = asyncio.Lock()


def generate_room_code(length: int = 6) -> str:
    code = "".join(random.choices(string.ascii_lowercase + string.digits, k=length))
    logger.debug(f"Generated room code: {code}")
    return code


async def get_or_create_room(code: str) -> Room:
    async with rooms_lock:
        room = rooms.get(code)
        if room is None:
            logger.info(f"Creating new room: {code}")
            room = Room(code)
            rooms[code] = room
        else:
            logger.debug(f"Room {code} already exists, players: {len(room.players)}")

        if room.cleanup_task and not room.cleanup_task.done():
            logger.debug(f"Cancel previous cleanup task for {code}")
            room.cleanup_task.cancel()
            room.cleanup_task = None
        return room


async def schedule_room_cleanup(code: str, delay_seconds: int = 60):
    async def _cleanup():
        try:
            await asyncio.sleep(delay_seconds)
            async with rooms_lock:
                room = rooms.get(code)

                # КРИТИЧЕСКОЕ ИСПРАВЛЕНИЕ:
                if room is None:
                    return

                if len(room.connections) == 0:
                    logger.info(f"Room {code} empty → deleting")
                    rooms.pop(code, None)
                else:
                    logger.debug(f"Room {code} not empty at cleanup, skip")
        except asyncio.CancelledError:
            logger.debug(f"Cleanup for {code} cancelled")
        except Exception:
            logger.exception(f"Exception in cleanup task for {code}")


    async with rooms_lock:
        room = rooms.get(code)
        if not room or room.cleanup_task:
            return
        room.cleanup_task = asyncio.create_task(_cleanup())
        logger.debug(f"Scheduled cleanup for {code} in {delay_seconds}s")

app.mount("/static", StaticFiles(directory="static"), name="static")

@app.get("/", response_class=HTMLResponse)
async def root():
    code = generate_room_code()
    logger.info(f"Root → redirect to /room/{code}")
    return RedirectResponse(url=f"/room/{code}")


@app.get("/room", response_class=HTMLResponse)
async def room_without_code():
    code = generate_room_code()
    return RedirectResponse(url=f"/room/{code}")


@app.get("/room/{room_code}", response_class=HTMLResponse)
async def room_page(room_code: str):
    with open("static/index.html", "r", encoding="utf-8") as f:
        return HTMLResponse(content=f.read())


@app.get("/favicon.ico")
async def favicon():
    # Возвращаем пустой ответ для favicon, чтобы убрать 404 ошибку
    from fastapi.responses import Response
    return Response(content=b"", media_type="image/x-icon")


async def broadcast(room: Room, message: dict):
    dead: List[WebSocket] = []
    for ws in list(room.connections):
        try:
            await ws.send_json(message)
            logger.debug(f"[{room.code}] → {message['type']} to {room.players.get(ws)}")
        except Exception as e:
            logger.warning(f"[{room.code}] send failed: {e}")
            dead.append(ws)
    for ws in dead:
        room.remove_connection(ws)


def roll_dice(quantity: int, sides: int) -> List[int]:
    return [random.randint(1, sides) for _ in range(quantity)]


@app.websocket("/ws/{room_code}")
async def websocket_endpoint(websocket: WebSocket, room_code: str):
    logger.info(f"WS connection attempt → {room_code}")
    await websocket.accept()
    room = await get_or_create_room(room_code)

    nickname: Optional[str] = None

    try:
        join_msg = await websocket.receive_json()
        logger.debug(f"[{room_code}] first msg: {join_msg}")

        if join_msg.get("type") != "join" or "nickname" not in join_msg:
            logger.warning(f"[{room_code}] invalid join message")
            await websocket.close(code=1003)
            return

        nickname = str(join_msg["nickname"]).strip() or "Гость"
        room.add_connection(websocket, nickname)

        await broadcast(
            room,
            {
                "type": "player_joined",
                "nickname": nickname,
                "players": list(room.players.values()),
                "players_order": room.get_players_order(),  # Порядок хода
                "current_player": room.get_current_player_nickname(),  # Текущий игрок
                "is_turn_based": room.is_turn_based,
            },
        )

        while True:
            data = await websocket.receive_json()
            logger.debug(f"[{room_code}] ← {nickname}: {data}")

            if data.get("type") == "dice_roll":
                if room.is_turn_based:
                    current_player = room.get_current_player()
                    if current_player != websocket:
                        # Игрок пытается бросить не в свою очередь
                        error_msg = {
                            "type": "error",
                            "message": f"Сейчас ход игрока {room.get_current_player_nickname()}. Дождитесь своей очереди."
                        }
                        await websocket.send_json(error_msg)
                        continue

                dice_type = data.get("dice_type", "d6")
                quantity = int(data.get("quantity", 1))
                custom_sides = int(data.get("custom_sides", 0))

                if dice_type == "custom" and custom_sides > 1:
                    sides = custom_sides
                    notation = f"{quantity}d{custom_sides}"
                else:
                    try:
                        sides = int(dice_type.lstrip("dD"))
                    except ValueError:
                        sides = 6
                    notation = f"{quantity}d{sides}"

                quantity = max(1, min(quantity, 20))
                sides = max(2, sides)
                rolls = roll_dice(quantity, sides)
                total = sum(rolls)

                result = {
                    "type": "dice_result",
                    "nickname": nickname,
                    "dice_type": dice_type,
                    "dice_notation": notation,
                    "quantity": quantity,
                    "sides": sides,
                    "rolls": rolls,
                    "total": total,
                }

                room.history.append(result)
                if len(room.history) > 50:
                    room.history = room.history[-50:]

                await broadcast(room, {
                    "type": "dice_roll", 
                    "nickname": nickname, 
                    "dice_notation": notation,
                    "quantity": quantity, 
                    "sides": sides
                })
                await broadcast(room, result)
                
                if room.is_turn_based:
                    room.next_turn()
                    # Отправляем обновленную очередь
                    await broadcast(room, {
                        "type": "turn_update",
                        "players_order": room.get_players_order(),
                        "current_player": room.get_current_player_nickname(),
                        "is_turn_based": room.is_turn_based,
                    })

            elif data.get("type") == "change_mode":
                # Только создатель комнаты может менять режим
                room.is_turn_based = data.get("turn_based", True)
                # Отправляем обновленную очередь всем игрокам
                await broadcast(room, {
                    "type": "turn_update",
                    "players_order": room.get_players_order(),
                    "current_player": room.get_current_player_nickname(),
                    "is_turn_based": room.is_turn_based,
                })

    except WebSocketDisconnect:
        logger.info(f"[{room_code}] disconnect {nickname}")
    except Exception as e:
        logger.exception(f"[{room_code}] unexpected error: {e}")
    finally:
        if nickname:
            players_snapshot = []
            room_was_empty = False
            room_ref = None

            async with rooms_lock:
                room = rooms.get(room_code)
                if room and websocket in room.connections:
                    room.remove_connection(websocket)
                    players_snapshot = list(room.players.values())
                    room_was_empty = room.is_empty()
                    room_ref = room

            try:
                if room_ref is not None:
                    await broadcast(
                        room_ref,
                        {
                            "type": "player_left",
                            "nickname": nickname,
                            "players": players_snapshot,
                            "players_order": room_ref.get_players_order(),
                            "current_player": room_ref.get_current_player_nickname(),
                            "is_turn_based": room_ref.is_turn_based,
                        },
                    )
                    if room_was_empty:
                        await schedule_room_cleanup(room_code)
            except Exception as e:
                logger.exception(f"[{room_code}] error during final cleanup broadcast/schedule: {e}")
