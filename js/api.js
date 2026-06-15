async function kontekstno_query({
    method = '',
    word = '',
    challenge_id = '',
    last_word_rank = 0
} = {}) {

    // const BASE_DOMAIN = 'https://xn--80aqu.xn--e1ajbkccewgd.xn--p1ai/';
    const BASE_DOMAIN = 'https://api.contextno.com/';

    // 1. Создаем объект URL. Он сам склеит домен и метод правильно.
    if (!method) {
        throw new Error('kontekstno_query: method не указан');
    }

    const url = new URL(method, BASE_DOMAIN);

    // 2. Добавляем параметры в зависимости от метода
    switch (method) {

        case 'score':
            url.searchParams.set('challenge_id', challenge_id);
            url.searchParams.set('word', word);
            url.searchParams.set('challenge_type', 'random');
            break;

        case 'tip':
            url.searchParams.set('challenge_id', challenge_id);
            url.searchParams.set('last_word_rank', last_word_rank);
            url.searchParams.set('challenge_type', 'random');
            break;

        // Для 'random-challenge' параметры не нужны, url остается чистым
        case 'random-challenge':
            break;

        default:
            throw new Error(`Неизвестный method: ${method}`);
    }

    // Таймаут для запроса
    const controller = new AbortController();

    const timeout = setTimeout(() => {
        controller.abort();
    }, 10000);

    try {
        // 3. Делаем запрос
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                'Accept': 'application/json'
            }
        });

        if (!response.ok) {
            let errorText = '';
            try {
                errorText = await response.text();
                if (errorText.length > 200) {
                    errorText = errorText.substring(0, 200) + '...';
                }
            } catch {}
            throw new Error(
                `HTTP ${response.status} ${response.statusText} ${errorText}`
            );
        }

        let data;

        try {
            data = await response.json();
        } catch (jsonError) {
            throw new Error(
                `Ошибка парсинга JSON: ${jsonError.message}`
            );
        }

        // базовая валидация ответа
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('API вернул некорректный JSON');
        }

        return data;

    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Таймаут запроса к Contextno API');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

async function sendWebhookEvent(event = '', data = {}) {
    if (!webhook_url || !event) return;

    try {
        await fetch(webhook_url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                channel: channel_name,
                secret: webhook_secret,
                event: event,
                data: data
            })
        });
    } catch (error) {
        console.warn(`Не удалось отправить webhook событие "${event}"`, error);
    }
}

// --- Game backends ----------------------------------------------------------
// Slovotron can talk to two stateless word-guessing backends. Each one exposes
// the same interface so the rest of the game stays backend-agnostic:
//   createGame()          -> { gameId, secretWord }
//   score(gameId, word)   -> { distance }   (distance falsy => not in vocabulary)
//   tip(gameId, lastRank) -> { word, distance }   (optional; null if unsupported)

const WORDGUN_BASE_URL = 'https://api.wordgun.ru/v1';

async function wordgun_request(path, { method = 'GET', body = null } = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    try {
        const response = await fetch(`${WORDGUN_BASE_URL}${path}`, {
            method,
            signal: controller.signal,
            headers: {
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            body: body ? JSON.stringify(body) : undefined
        });

        if (!response.ok) {
            let errorBody = null;
            try { errorBody = await response.json(); } catch {}
            const error = new Error(`Wordgun HTTP ${response.status}: ${errorBody?.error || response.statusText}`);
            error.status = response.status;
            error.code = errorBody?.code;
            throw error;
        }

        return await response.json();
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error('Таймаут запроса к Wordgun API');
        }
        throw error;
    } finally {
        clearTimeout(timeout);
    }
}

const GAME_BACKENDS = {
    // контекстно.рф — original backend. Opaque challenge_id, "distance" score,
    // supports hint words via the tip endpoint and discloses the secret word.
    kontekstno: {
        id: 'kontekstno',
        label: 'контекстно.рф',
        supportsTips: true,

        async createGame() {
            const data = await kontekstno_query({ method: 'random-challenge' });
            const room_id = data.id;

            // Проверка на забагованное слово.
            // Если для "банан" возвращается 0, значит игра сломана и надо перезапустить.
            const check = await kontekstno_query({
                method: 'score',
                word: 'банан',
                challenge_id: room_id
            });

            if (check.distance === 0) {
                throw new Error(`Слово ID ${room_id} забаговано (дистанция для "банан" = 0).`);
            }

            let secret_word = null;
            try {
                const secretWordResponse = await kontekstno_query({
                    method: 'tip',
                    challenge_id: room_id,
                    last_word_rank: 1
                });
                secret_word = secretWordResponse?.word || null;
            } catch (secretWordError) {
                console.warn('Не удалось получить секретное слово через tip(last_word_rank=1):', secretWordError);
            }

            return { gameId: room_id, secretWord: secret_word };
        },

        async score(gameId, word) {
            const result = await kontekstno_query({
                method: 'score',
                word: word,
                challenge_id: gameId
            });
            return { distance: result.distance };
        },

        async tip(gameId, lastRank) {
            const result = await kontekstno_query({
                method: 'tip',
                challenge_id: gameId,
                last_word_rank: lastRank
            });
            return { word: result?.word, distance: result?.distance };
        }
    },

    // wordgun.ru — stateless API (see public-api-v1.md). The game lives inside an
    // opaque token; a guess returns { in_vocab, rank }. No hint endpoint and the
    // secret word is never disclosed.
    wordgun: {
        id: 'wordgun',
        label: 'wordgun.ru',
        supportsTips: false,

        async createGame() {
            const data = await wordgun_request('/games', { method: 'POST' });
            // Wordgun never reveals the secret word, so it stays null.
            return { gameId: data.token, secretWord: null };
        },

        async score(gameId, word) {
            const result = await wordgun_request('/guess', {
                method: 'POST',
                body: { token: gameId, word: word }
            });
            // Normalize to the shared { distance } shape: rank is the distance,
            // an out-of-vocabulary guess has no distance.
            return { distance: result.in_vocab ? result.rank : undefined };
        },

        tip: null
    }
};

function getActiveBackend() {
    return GAME_BACKENDS[game_backend] || GAME_BACKENDS.kontekstno;
}

function backend_supports_tips() {
    return !!getActiveBackend().supportsTips;
}

// Score a guess with the active backend. Returns { distance }: a positive number
// when the word is in vocabulary, undefined otherwise.
async function score_word(word, gameId) {
    return getActiveBackend().score(gameId, word);
}

// Request a hint word from the active backend, or null if it has no tip support.
async function get_tip(gameId, lastRank) {
    const backend = getActiveBackend();
    if (typeof backend.tip !== 'function') return null;
    return backend.tip(gameId, lastRank);
}

async function generate_secret_word() {
    const backend = getActiveBackend();
    let retry_count = 0;
    const max_retries = 5;

    while (retry_count < max_retries) {
        try {
            const game = await backend.createGame();
            current_secret_word_data = {
                challenge_id: game.gameId,
                secret_word: game.secretWord ?? null
            };
            return game.gameId;
        } catch (e) {
            console.warn(`Не удалось создать игру (${backend.id}). Попытка ${retry_count + 1}/${max_retries}:`, e);
            retry_count++;
            // Небольшая пауза перед повтором при сетевой ошибке
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    show_fullscreen_error('Ошибка получения секретного слова.<br>Пожалуйста, попробуйте зайти позже.');
    throw new Error('Превышено количество попыток получения секретного слова.');
}

function show_fullscreen_error(message) {
    // Удаляем предыдущую ошибку, если она есть
    const existing = document.querySelector('.error-overlay');
    if (existing) existing.remove();

    const error_html = `
        <div class="error-overlay">
            <div class="error-content">
                <div class="error-icon">⚠️</div>
                <div class="error-message">${message}</div>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', error_html);
}

async function getTwitchUserData(username) {
    try {
        const response = await fetch(`https://api.ivr.fi/v2/twitch/user?login=${username}`);
        const data = await response.json();

        if (data && data[0]) {
            return data[0];
        } else {
            console.error("Пользователь не найден");
        }
    } catch (error) {
        console.error("Ошибка запроса:", error);
    }
    return null;
}
