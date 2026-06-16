// 文档加载完成后调整按钮位置
$(document).ready(function() {
    var videoTogetherSamllIcon = $('#videoTogetherSamllIcon');
    if (videoTogetherSamllIcon.length > 0) {
        videoTogetherSamllIcon.css('top', '-20px');
    }
});

// 监听浏览器返回事件
window.addEventListener('popstate', function(event) {
    location.reload(true);
});

// 检测是否在手机端并进入全屏后检测方向并执行横屏操作
if (window.matchMedia("(max-width: 768px)").matches) {
    document.addEventListener('fullscreenchange', function(event) {
        if (document.fullscreenElement) {
            checkAndForceLandscape();
        }
    });
}

// 检测设备方向并执行横屏操作
function checkAndForceLandscape() {
    if (screen.orientation && screen.orientation.lock) {
        screen.orientation.lock('landscape').catch(function() {
            // iOS Safari 等浏览器不支持 orientation.lock，静默失败
        });
    }
}
