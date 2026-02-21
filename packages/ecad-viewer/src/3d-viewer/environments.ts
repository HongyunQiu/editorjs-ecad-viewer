const ENABLE_REMOTE_ENV =
	(globalThis as any).ECAD_VIEWER_ENABLE_REMOTE_ENV === true;

export const environments = [
	{
		id: '',
		name: 'None',
		path: null,
	},
	{
		id: 'neutral', // THREE.RoomEnvironment
		name: 'Neutral',
		path: null,
	},
	// 远程环境贴图默认关闭：弱网/离线时避免请求外部地址导致加载失败或卡住。
	// 如需开启，可在页面里设置：window.ECAD_VIEWER_ENABLE_REMOTE_ENV = true
	...(ENABLE_REMOTE_ENV
		? [
				{
					id: 'venice-sunset',
					name: 'Venice Sunset',
					path: 'https://storage.googleapis.com/donmccurdy-static/venice_sunset_1k.exr',
					format: '.exr',
				},
				{
					id: 'footprint-court',
					name: 'Footprint Court (HDR Labs)',
					path: 'https://storage.googleapis.com/donmccurdy-static/footprint_court_2k.exr',
					format: '.exr',
				},
			]
		: []),
];
