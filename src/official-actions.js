// The deployed Android player resolves these 61 legacy runtime ids to stable
// semantics. Keep the runtime id because it is also the action JSON filename.
const ACTION_IDS = [
  ["0806数据结构20分_黑眼圈遮瑕.json", "concealer_dark_circle_step1_left"],
  ["0806数据结构20分_黑眼圈遮瑕 (镜像).json", "concealer_dark_circle_step1_right"],
  ["0806黑眼圈遮瑕step2_L.json", "concealer_dark_circle_step2_left"],
  ["0806黑眼圈遮瑕step2_L (镜像).json", "concealer_dark_circle_step2_right"],
  ["0806法令纹遮瑕step1_L.json", "concealer_nasolabial_step1_left"],
  ["0806法令纹遮瑕step1_L (镜像).json", "concealer_nasolabial_step1_right"],
  ["0806法令纹遮瑕step2_L.json", "concealer_nasolabial_step2_left"],
  ["0806法令纹遮瑕step2_L (镜像).json", "concealer_nasolabial_step2_right"],
  ["遮瑕眼袋_L.json", "concealer_eye_bag_left"],
  ["遮瑕眼袋_L (镜像).json", "concealer_eye_bag_right"],
  ["0806眉毛_L.json", "eyebrow_left"],
  ["0806眉毛_L (镜像).json", "eyebrow_right"],
  ["0806眼影打底_L.json", "eyeshadow_base_left"],
  ["0806眼影打底_L (镜像).json", "eyeshadow_base_right"],
  ["0806眼影加深_L.json", "eyeshadow_deepen_left"],
  ["0806眼影加深_L (镜像).json", "eyeshadow_deepen_right"],
  ["眼影提亮_L.json", "eyeshadow_highlight_left"],
  ["眼影提亮_L (镜像).json", "eyeshadow_highlight_right"],
  ["眼影下至_R.json", "eyeshadow_lower_eyelid_right"],
  ["眼影下至_R (镜像).json", "eyeshadow_lower_eyelid_left"],
  ["眼影宽眼距_L.json", "eyeshadow_wide_set_left"],
  ["眼影宽眼距_L (镜像).json", "eyeshadow_wide_set_right"],
  ["眼影窄眼距_L.json", "eyeshadow_narrow_set_left"],
  ["眼影窄眼距_L (镜像).json", "eyeshadow_narrow_set_right"],
  ["肿眼泡眼影_R (镜像).json", "eyeshadow_monolid_left"],
  ["肿眼泡眼影_R (镜像) (镜像).json", "eyeshadow_monolid_right"],
  ["眼线默认_R.json", "eyeliner_normal_right"],
  ["眼线默认_R (镜像).json", "eyeliner_normal_left"],
  ["眼线肿眼泡_R.json", "eyeliner_monolid_right"],
  ["眼线肿眼泡_R (镜像).json", "eyeliner_monolid_left"],
  ["0806粉底step1_L.json", "foundation_step1_left"],
  ["0806粉底step1_L (镜像).json", "foundation_step1_right"],
  ["0806粉底_下巴.json", "foundation_chin"],
  ["粉底step1_额头.json", "foundation_forehead"],
  ["粉底整个脸拍开.json", "foundation_whole_face"],
  ["0811腮红默认_R.json", "blush_round_right"],
  ["0811腮红默认_R (镜像).json", "blush_round_left"],
  ["0811腮红默认_R (镜像)_copy_mso31dag.json", "blush_square_left"],
  ["0811腮红默认_R (镜像)_copy_mso31dag (镜像).json", "blush_square_right"],
  ["腮红长脸_L.json", "blush_long_right"],
  ["腮红长脸_L (镜像).json", "blush_long_left"],
  ["腮红菱形_L.json", "blush_diamond_left"],
  ["腮红菱形_L (镜像).json", "blush_diamond_right"],
  ["腮红下庭长.json", "blush_lower_face_long"],
  ["面颊修容圆脸R.json", "face_contour_round_right"],
  ["面颊修容圆脸R (镜像).json", "face_contour_round_left"],
  ["面颊修容方脸_R.json", "face_contour_square_right"],
  ["面颊修容方脸_R (镜像).json", "face_contour_square_left"],
  ["面颊修容菱形脸_R.json", "face_contour_diamond_right"],
  ["面颊修容菱形脸_R (镜像).json", "face_contour_diamond_left"],
  ["面颊修容面部留白多_R.json", "face_contour_sparse_right"],
  ["面颊修容面部留白多_R (镜像).json", "face_contour_sparse_left"],
  ["修容上庭长.json", "face_contour_upper_face_long"],
  ["鼻修容塌鼻梁.json", "nose_contour_low_bridge"],
  ["鼻修容宽鼻粱.json", "nose_contour_wide_bridge"],
  ["鼻修容默认.json", "nose_contour_normal"],
  ["鼻修容鼻翼宽.json", "nose_contour_wide_ala"],
  ["高光标准.json", "highlight_standard"],
  ["高光标准_copy_mspsy8yo.json", "highlight_diamond"],
  ["全脸定妆.json", "full_face_setting"],
  ["嘴唇1.json", "lip_lower_thin"],
];

const CATEGORY_LABELS = {
  concealer: "遮瑕",
  eyebrow: "眉毛",
  eyeshadow: "眼影",
  eyeliner: "眼线",
  foundation: "粉底",
  blush: "腮红",
  face_contour: "面部修容",
  nose_contour: "鼻修容",
  highlight: "高光",
  full_face_setting: "定妆",
  lip: "唇妆",
};

const INSTRUCTIONS = {
  concealer: "沿标记区域少量多次点涂，笔触按原动作轨迹移动",
  eyebrow: "顺着眉毛生长方向移动，保持工具头贴合眉形",
  eyeshadow: "刷头贴近眼褶，按原动作路径小范围晕染",
  eyeliner: "从眼部内侧向外移动，沿睫毛根部完成笔触",
  foundation: "按动作轨迹从面中向外推开，保持工具贴合脸部曲面",
  blush: "沿腮红区域轻扫，跟随脸部转动保持正确落点",
  face_contour: "沿轮廓区域移动，工具和路径同步贴合脸部曲面",
  nose_contour: "沿鼻部标记路径少量移动，保持笔触范围准确",
  highlight: "沿高光区域轻扫，按原始动作控制范围",
  full_face_setting: "粉扑按原动作轨迹连续轻拍完成定妆",
  lip: "沿唇部区域移动，保持工具头落在唇线范围内",
};

function semanticCategory(canonicalId) {
  return ["face_contour", "nose_contour", "full_face_setting"]
    .find((prefix) => canonicalId.startsWith(prefix))
    ?? canonicalId.split("_")[0];
}

function toolModeFor(category) {
  if (category === "eyebrow" || category === "eyeliner" || category === "lip") return "brow";
  if (category === "eyeshadow") return "eyeshadow";
  if (category === "foundation" || category === "concealer") return "foundation";
  if (category === "full_face_setting") return "powder";
  return "contour";
}

function cleanDisplayName(runtimeId, side) {
  const name = runtimeId
    .replace(/\.json$/i, "")
    .replace(/^0806|^0811/g, "")
    .replace(/^数据结构20分[ _]*/g, "")
    .replace(/_copy_[a-z0-9]+/gi, "")
    .replace(/\s*\(镜像\)/g, "")
    .replace(/_[LR]\b/g, "")
    .replace(/_/g, " ")
    .trim();
  return `${name}${side ? ` · ${side === "left" ? "左侧" : "右侧"}` : ""}`;
}

export const OFFICIAL_ACTIONS = ACTION_IDS.map(([runtimeId, canonicalId], index) => {
  const category = semanticCategory(canonicalId);
  const side = canonicalId.endsWith("_left") ? "left" : canonicalId.endsWith("_right") ? "right" : null;
  return {
    index: index + 1,
    runtimeId,
    canonicalId,
    category,
    categoryLabel: CATEGORY_LABELS[category],
    displayName: cleanDisplayName(runtimeId, side),
    instruction: INSTRUCTIONS[category],
    side,
    toolMode: toolModeFor(category),
  };
});

export const DEFAULT_OFFICIAL_ACTION = OFFICIAL_ACTIONS.find(
  (action) => action.canonicalId === "foundation_whole_face",
);
