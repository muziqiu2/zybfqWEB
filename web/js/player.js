$(document).ready(function () {
    let art = null;
    let videoUrl = '';
    let controlsTimer = null;

    // DOM
    const $startScreen = $('#startScreen');
    const $loader = $('#loader');
    const $urlInput = $('#urlInput');
    const $playBtn = $('#playBtn');
    const $controls = $('#controls');
    const $playPauseBtn = $('#playPauseBtn');
    const $progressBar = $('#progressBar');
    const $progressFill = $('#progressFill');
    const $timeLabel = $('#timeLabel');
    const $fullscreenBtn = $('#fullscreenBtn');
    const $videoWrapper = $('#videoWrapper');
    const $iconPlay = $('.icon-play');
    const $iconPause = $('.icon-pause');

    // 格式化时间
    const formatTime = (s) => {
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = Math.floor(s % 60);
        const mm = m.toString().padStart(2, '0');
        const ss = sec.toString().padStart(2, '0');
        return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
    };

    // 检测格式
    const getType = (url) => url.includes('.m3u8') ? 'm3u8' : 'mp4';

    // 显示控制栏
    const showControls = () => {
        $controls.addClass('visible');
        clearTimeout(controlsTimer);
        controlsTimer = setTimeout(() => {
            if (art && !art.paused) {
                $controls.removeClass('visible');
            }
        }, 3000);
    };

    // 播放
    const play = (url) => {
        if (!url) return;
        videoUrl = url;
        $loader.addClass('active');
        $startScreen.addClass('hidden');

        if (art?.id) art.destroy();

        const type = getType(url);

        try {
            art = new Artplayer({
                container: '#player',
                url: url,
                title: '自由播放器',
                loop: true,
                playbackRate: true,
                fullscreen: true,
                theme: '#64ffda',
                setting: false,
                pip: false,
                screenshot: false,
                miniProgressBar: false,
                customType: type === 'm3u8' ? { m3u8: playM3u8 } : {},
                plugins: type === 'm3u8' ? [
                    artplayerPluginControl(),
                    artplayerPluginHlsQuality({ control: true, setting: false })
                ] : [],
            });

            art.on('ready', () => {
                $loader.removeClass('active');
                art.play();
                showControls();
            });

            art.on('play', () => {
                $iconPlay.hide();
                $iconPause.show();
            });

            art.on('pause', () => {
                $iconPlay.show();
                $iconPause.hide();
                $controls.addClass('visible');
            });

            art.on('video:timeupdate', (v) => {
                const pct = (v.currentTime / v.duration) * 100;
                $progressFill.css('width', `${pct}%`);
                $timeLabel.text(`${formatTime(v.currentTime)} / ${formatTime(v.duration)}`);
            });

            art.on('ended', () => {
                $iconPlay.show();
                $iconPause.hide();
                $controls.addClass('visible');
            });

            art.on('error', () => {
                $loader.removeClass('active');
                layer.msg('视频加载失败');
            });

        } catch (e) {
            console.error(e);
            $loader.removeClass('active');
        }
    };

    // M3U8
    const playM3u8 = (video, url, ap) => {
        if (Hls.isSupported()) {
            const hls = new Hls();
            ap.hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            ap.once('destroy', () => hls.destroy());
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
        } else {
            ap.notice.show = '不支持的格式';
        }
    };

    // 播放按钮
    $playBtn.on('click', () => {
        const url = $urlInput.val().trim();
        if (!url) {
            layer.msg('请输入视频链接');
            return;
        }
        play(url);
        window.location.hash = 'v=' + encodeURIComponent(url);
    });

    // 回车
    $urlInput.on('keypress', (e) => {
        if (e.key === 'Enter') $playBtn.click();
    });

    // 点击视频区域
    $videoWrapper.on('click', () => {
        if (!art) return;
        showControls();
        art.paused ? art.play() : art.pause();
    });

    // 进度条点击
    $progressBar.on('click', (e) => {
        if (!art) return;
        const rect = $progressBar[0].getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        art.seek = art.duration * pct;
    });

    // 播放/暂停
    $playPauseBtn.on('click', () => {
        if (!art) return;
        art.paused ? art.play() : art.pause();
        showControls();
    });

    // 全屏
    $fullscreenBtn.on('click', () => {
        if (art) art.fullscreen = !art.fullscreen;
        showControls();
    });

    // 移动
    $videoWrapper.on('mousemove', () => {
        if (art && !art.paused) showControls();
    });

    // 读取 hash
    const hash = window.location.hash;
    if (hash.startsWith('#v=')) {
        const url = decodeURIComponent(hash.slice(3));
        $urlInput.val(url);
        play(url);
    }

    window.addEventListener('popstate', () => location.reload(true));
});
