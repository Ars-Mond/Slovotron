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

async function generate_secret_word() {
    let room_id;
    let is_bugged = true;
    let retry_count = 0;
    const max_retries = 5;

    while (is_bugged) {
        if (retry_count >= max_retries) {
            show_fullscreen_error('Ошибка получения секретного слова.<br>Пожалуйста, попробуйте зайти позже.');
            throw new Error('Превышено количество попыток получения секретного слова.');
        }

        const data = await kontekstno_query({ method: 'random-challenge' });
        room_id = data.id;

        // Проверка на забагованное слово.
        // Если для "банан" возвращается 0, значит игра сломана и надо перезапустить.
        try {
            const check = await kontekstno_query({
                method: 'score',
                word: 'банан',
                challenge_id: room_id
            });

            if (check.distance === 0) {
                console.warn(`Слово ID ${room_id} забаговано (дистанция для "банан" = 0). Попытка ${retry_count + 1}/${max_retries}...`);
                retry_count++;
            } else {
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

                current_secret_word_data = {
                    challenge_id: room_id,
                    secret_word: secret_word
                };
                is_bugged = false;
            }
        } catch (e) {
            console.error('Ошибка при проверке слова на баг:', e);
            retry_count++;
            // Небольшая пауза перед повтором при сетевой ошибке
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

    return room_id;
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
