const demoVideoUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

$(document).ready(function () {
    let art = null;
    let videoUrl = '';
    let controlsTimeout = null;

    // DOM 元素
    const $inputOverlay = $('#inputOverlay');
    const $controls = $('#controls');
    const $urlInput = $('#urlInput');
    const $playBtn = $('#playBtn');
    const $loadingOverlay = $('#loadingOverlay');
    const $playPauseBtn = $('#playPauseBtn');
    const $progressArea = $('#progressArea');
    const $progressBar = $('#progressBar');
    const $timeDisplay = $('#timeDisplay');
    const $fullscreenBtn = $('#fullscreenBtn');
    const $videoWrapper = $('#videoWrapper');
    const $iconPlay = $('.icon-play');
    const $iconPause = $('.icon-pause');

    // 格式化时间
    const formatTime = (seconds) => {
        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);
        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
    };

    // 检测视频格式
    const getVideoType = (url) => {
        if (url.includes('.m3u8')) return 'm3u8';
        return 'mp4';
    };

    // 播放视频
    const playVideo = (url) => {
        if (!url) return;

        videoUrl = url;
        $loadingOverlay.addClass('visible');
        $inputOverlay.addClass('hidden');

        // 销毁旧播放器
        if (art?.id) {
            art.destroy();
        }

        const videoType = getVideoType(url);

        try {
            art = new Artplayer({
                container: '#player',
                url: url,
                title: '自由播放器',
                loop: true,
                playbackRate: true,
                fullscreen: true,
                fullscreenWeb: false,
                theme: '#e63946',
                setting: false,
                pip: false,
                screenshot: false,
                miniProgressBar: false,
                icons: {
                    loading: '<div class="loading-spinner"></div>'
                },
                customType: videoType === 'm3u8' ? {
                    m3u8: playM3u8,
                } : {},
                plugins: videoType === 'm3u8' ? [
                    artplayerPluginControl(),
                    artplayerPluginHlsQuality({
                        control: true,
                        setting: false,
                    })
                ] : [],
            });

            // 播放器就绪
            art.on('ready', () => {
                $loadingOverlay.removeClass('visible');
                art.play();
                showControls();
            });

            // 显示控制栏
            art.on('play', () => {
                $iconPlay.hide();
                $iconPause.show();
            });

            art.on('pause', () => {
                $iconPlay.show();
                $iconPause.hide();
            });

            // 更新进度条
            art.on('video:progress', (rect) => {
                const percent = (rect.currentTime / rect.duration) * 100;
                $progressBar.css('width', `${percent}%`);
                $timeDisplay.text(`${formatTime(rect.currentTime)} / ${formatTime(rect.duration)}`);
            });

            // 播放结束
            art.on('ended', () => {
                $iconPlay.show();
                $iconPause.hide();
            });

            // 错误处理
            art.on('error', () => {
                $loadingOverlay.removeClass('visible');
                layer.msg('视频加载失败，请检查链接是否有效');
            });

        } catch (e) {
            console.error('播放器错误:', e);
            $loadingOverlay.removeClass('visible');
        }
    };

    // M3U8 播放处理
    const playM3u8 = (video, url, artplayer) => {
        if (Hls.isSupported()) {
            const hls = new Hls();
            artplayer.hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            artplayer.once('destroy', () => hls.destroy());
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = url;
        } else {
            artplayer.notice.show = '不支持的播放格式';
        }
    };

    // 显示控制栏
    const showControls = () => {
        $controls.addClass('visible');
        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (art && !art.paused) {
                $controls.removeClass('visible');
            }
        }, 3000);
    };

    // 播放按钮点击
    $playBtn.on('click', () => {
        const url = $urlInput.val().trim();
        if (!url) {
            layer.msg('请输入视频链接');
            return;
        }
        playVideo(url);
        window.location.hash = 'video_url=' + encodeURIComponent(url);
    });

    // 输入框回车
    $urlInput.on('keypress', (e) => {
        if (e.key === 'Enter') {
            $playBtn.click();
        }
    });

    // 视频区域点击 - 显示/隐藏控制栏
    $videoWrapper.on('click', () => {
        if (art) {
            showControls();
            if (art.paused) {
                art.play();
            }
        }
    });

    // 进度条点击跳转
    $progressArea.on('click', (e) => {
        if (!art) return;
        const rect = $progressArea[0].getBoundingClientRect();
        const percent = (e.clientX - rect.left) / rect.width;
        const duration = art.duration;
        if (duration) {
            art.seek = duration * percent;
        }
    });

    // 播放/暂停按钮
    $playPauseBtn.on('click', () => {
        if (!art) return;
        if (art.paused) {
            art.play();
        } else {
            art.pause();
        }
        showControls();
    });

    // 全屏按钮
    $fullscreenBtn.on('click', () => {
        if (!art) return;
        art.fullscreen = !art.fullscreen;
        showControls();
    });

    // 鼠标移动显示控制栏
    $videoWrapper.on('mousemove', () => {
        if (art && !art.paused) {
            showControls();
        }
    });

    // 从 URL hash 读取视频
    const hash = window.location.hash;
    if (hash.startsWith('#video_url=')) {
        const url = decodeURIComponent(hash.substr('#video_url='.length));
        $urlInput.val(url);
        playVideo(url);
    }

    // 监听浏览器返回
    window.addEventListener('popstate', () => {
        location.reload(true);
    });
});
