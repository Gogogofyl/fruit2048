// 抖音原生小游戏入口：按依赖顺序加载模块，再启动游戏。
require('./js/platform.js');
require('./js/tile.js');
require('./js/grid.js');
require('./js/storage_manager.js');
require('./js/input_manager.js');
require('./js/renderer.js');
require('./js/game_manager.js');

new GameManager(4, InputManager, Renderer, StorageManager);
