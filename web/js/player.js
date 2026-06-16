const demoVideoUrl = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

$(document).ready(function () {
    let art = null;
    let videoUrl = '';

    const playVideo = (videoUrl) => {
        $('.main').removeClass('ready');
        if (videoUrl === '') {
            videoUrl = demoVideoUrl;
            layer.open({
                icon: 5,
                time: 5 * 1000,
                title: '错误提示',
                content: '请输入m3u8视频地址，当前播放为演示视频。',
                btn: ['知道了']
            });
        }
        if (videoUrl) {
            $('.form-control>.url').val(videoUrl);
            window.location.hash = 'video_url=' + encodeURIComponent(videoUrl);
        }
        if (art?.id) {
            art.destroy();
        }
        try {
            art = new Artplayer({
                container: '.player',
                url: videoUrl,
                title: '自由播放器',
                loop: true,
                flip: false,
                playbackRate: true,
                aspectRatio: false,
                screenshot: false,
                setting: true,
                pip: true,
                fullscreenWeb: false,
                fullscreen: true,
                subtitleOffset: true,
                miniProgressBar: true,
                airplay: true,
                theme: '#23ade5',
                thumbnails: {},
                subtitle: {},
                highlight: [{
                    time: 15,
                    text: '欢迎使用自由播放器',
                }],
                icons: {
                    loading: '<img src="images/loading.gif" width="100px" title="视频加载中..." />'
                },
                settings: [{
                    html: '控件栏浮动',
                    icon: '<img width="22" height="22" src="images/state.svg">',
                    tooltip: '开启',
                    switch: true,
                    onSwitch: async (item) => {
                        item.tooltip = item.switch ? '关闭' : '开启';
                        art.plugins.artplayerPluginControl.enable = !item.switch;
                        await Artplayer.utils.sleep(300);
                        art.setting.updateStyle();
                        return !item.switch;
                    },
                }],
                customType: {
                    m3u8: playM3u8,
                },
                plugins: [
                    artplayerPluginControl(),
                    artplayerPluginHlsQuality({
                        control: true,
                        setting: false,
                        title: 'Quality',
                        auto: 'Auto',
                    })
                ],
            });
            art.on('ready', () => {
                setTimeout(() => {
                    layer.msg('开始播放');
                    art.play();
                }, 100);
            });
            art.on('error', (err) => {
                console.error('视频加载失败:', err);
                layer.msg('视频加载失败，请检查地址是否正确');
            });
        } catch (e) {
            console.error('发生异常:', e);
        }
    };

    const playM3u8 = (video, url, artplayer) => {
        if (Hls.isSupported()) {
            const hls = new Hls();
            artplayer.hls = hls;
            hls.loadSource(url);
            hls.attachMedia(video);
            artplayer.once('url', () => hls.destroy());
            artplayer.once('destroy', () => hls.destroy());
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            artplayer.switchUrl(url);
            artplayer.seek = 0;
        } else {
            artplayer.notice.show = '不支持的播放格式: m3u8';
        }
    };

    // 表单提交处理
    $('.form-control').on('submit', (e) => {
        e.preventDefault();
        const tempVideoUrl = $('.form-control>.url').val();
        if (tempVideoUrl === '') {
            layer.msg('请输入视频网址');
            return false;
        }
        if (videoUrl === tempVideoUrl) {
            layer.msg('视频网址没有改变');
            art.play();
            return false;
        }
        layer.msg('播放视频');
        videoUrl = tempVideoUrl;
        playVideo(videoUrl);
    });

    // 从 URL hash 读取视频地址
    const hash = window.location.hash;
    if (hash.startsWith('#video_url=')) {
        const tempVideoUrl = decodeURIComponent(hash.substr('#video_url='.length));
        playVideo(tempVideoUrl);
    }
});
