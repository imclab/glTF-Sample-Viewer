//
// This fragment shader defines a reference implementation for Physically Based Shading of
// a microfacet surface material defined by a glTF model.
//
// References:
// [1] Real Shading in Unreal Engine 4
//     http://blog.selfshadow.com/publications/s2013-shading-course/karis/s2013_pbs_epic_notes_v2.pdf
// [2] Physically Based Shading at Disney
//     http://blog.selfshadow.com/publications/s2012-shading-course/burley/s2012_pbs_disney_brdf_notes_v3.pdf
// [3] README.md - Environment Maps
//     https://github.com/KhronosGroup/glTF-WebGL-PBR/#environment-maps
// [4] "An Inexpensive BRDF Model for Physically based Rendering" by Christophe Schlick
//     https://www.cs.virginia.edu/~jdl/bib/appearance/analytic%20models/schlick94b.pdf
// [5] "KHR_materials_clearcoat"
//     https://github.com/KhronosGroup/glTF/tree/master/extensions/2.0/Khronos/KHR_materials_clearcoat

precision highp float;

#include <tonemapping.glsl>
#include <textures.glsl>
#include <functions.glsl>
#include <brdf.glsl>
#include <punctual.glsl>
#include <ibl.glsl>

out vec4 g_finalColor;

#ifdef USE_PUNCTUAL
uniform Light u_Lights[LIGHT_COUNT + 1]; //Array [0] is not allowed
#endif

// Metallic Roughness
uniform float u_MetallicFactor;
uniform float u_RoughnessFactor;
uniform vec4 u_BaseColorFactor;

// Specular Glossiness
uniform vec3 u_SpecularFactor;
uniform vec4 u_DiffuseFactor;
uniform float u_GlossinessFactor;

// Sheen
uniform float u_SheenRoughnessFactor;
uniform vec3 u_SheenColorFactor;

// Clearcoat
uniform float u_ClearcoatFactor;
uniform float u_ClearcoatRoughnessFactor;

// Transmission
uniform float u_TransmissionFactor;

// Alpha mode
uniform float u_AlphaCutoff;

uniform vec3 u_Camera;

#ifdef MATERIAL_TRANSMISSION
uniform ivec2 u_ScreenSize;
#endif

struct MaterialInfo
{
    float perceptualRoughness;      // roughness value, as authored by the model creator (input to shader)
    vec3 f0;                        // full reflectance color (n incidence angle)

    float alphaRoughness;           // roughness mapped to a more linear change in the roughness (proposed by [2])
    vec3 albedoColor;

    vec3 f90;                       // reflectance color at grazing angle
    float metallic;

    vec3 n;
    vec3 baseColor; // getBaseColor()

    float sheenRoughnessFactor;
    vec3 sheenColorFactor;

    vec3 clearcoatF0;
    vec3 clearcoatF90;
    float clearcoatFactor;
    vec3 clearcoatNormal;
    float clearcoatRoughness;

    float transmissionFactor;
};

// Get normal, tangent and bitangent vectors.
NormalInfo getNormalInfo(vec3 v)
{
    vec2 UV = getNormalUV();
    vec3 uv_dx = dFdx(vec3(UV, 0.0));
    vec3 uv_dy = dFdy(vec3(UV, 0.0));

    vec3 t_ = (uv_dy.t * dFdx(v_Position) - uv_dx.t * dFdy(v_Position)) /
        (uv_dx.s * uv_dy.t - uv_dy.s * uv_dx.t);

    vec3 n, t, b, ng;

    // Compute geometrical TBN:
    #ifdef HAS_TANGENTS
        // Trivial TBN computation, present as vertex attribute.
        // Normalize eigenvectors as matrix is linearly interpolated.
        t = normalize(v_TBN[0]);
        b = normalize(v_TBN[1]);
        ng = normalize(v_TBN[2]);
    #else
        // Normals are either present as vertex attributes or approximated.
        #ifdef HAS_NORMALS
            ng = normalize(v_Normal);
        #else
            ng = normalize(cross(dFdx(v_Position), dFdy(v_Position)));
        #endif

        t = normalize(t_ - ng * dot(ng, t_));
        b = cross(ng, t);
    #endif

    // For a back-facing surface, the tangential basis vectors are negated.
    if (gl_FrontFacing == false)
    {
        t *= -1.0;
        b *= -1.0;
        ng *= -1.0;
    }

    // Compute pertubed normals:
    #ifdef HAS_NORMAL_MAP
        n = texture(u_NormalSampler, UV).rgb * 2.0 - vec3(1.0);
        n *= vec3(u_NormalScale, u_NormalScale, 1.0);
        n = mat3(t, b, ng) * normalize(n);
    #else
        n = ng;
    #endif

    NormalInfo info;
    info.ng = ng;
    info.t = t;
    info.b = b;
    info.n = n;
    return info;
}

vec3 getClearcoatNormal(NormalInfo normalInfo)
{
    #ifdef HAS_CLEARCOAT_NORMAL_MAP
        vec3 n = texture(u_ClearcoatNormalSampler, getClearcoatNormalUV()).rgb * 2.0 - vec3(1.0);
        n *= vec3(u_ClearcoatNormalScale, u_ClearcoatNormalScale, 1.0);
        n = mat3(normalInfo.t, normalInfo.b, normalInfo.ng) * normalize(n);
        return n;
    #else
        return normalInfo.ng;
    #endif
}


vec4 getBaseColor()
{
    vec4 baseColor = vec4(1.0, 1.0, 1.0, 1.0);

    #if defined(MATERIAL_SPECULARGLOSSINESS)
        baseColor = u_DiffuseFactor;
    #elif defined(MATERIAL_METALLICROUGHNESS)
        baseColor = u_BaseColorFactor;
    #endif

    #if defined(MATERIAL_SPECULARGLOSSINESS) && defined(HAS_DIFFUSE_MAP)
        baseColor *= texture(u_DiffuseSampler, getDiffuseUV());
    #elif defined(MATERIAL_METALLICROUGHNESS) && defined(HAS_BASE_COLOR_MAP)
        baseColor *= texture(u_BaseColorSampler, getBaseColorUV());
    #endif

    return baseColor * getVertexColor();
}

MaterialInfo getSpecularGlossinessInfo(MaterialInfo info)
{
    info.f0 = u_SpecularFactor;
    info.perceptualRoughness = u_GlossinessFactor;

#ifdef HAS_SPECULAR_GLOSSINESS_MAP
    vec4 sgSample = texture(u_SpecularGlossinessSampler, getSpecularGlossinessUV());
    info.perceptualRoughness *= sgSample.a ; // glossiness to roughness
    info.f0 *= sgSample.rgb; // specular
#endif // ! HAS_SPECULAR_GLOSSINESS_MAP

    info.perceptualRoughness = 1.0 - info.perceptualRoughness; // 1 - glossiness
    info.albedoColor = info.baseColor.rgb * (1.0 - max(max(info.f0.r, info.f0.g), info.f0.b));

    return info;
}

MaterialInfo getMetallicRoughnessInfo(MaterialInfo info, float f0_ior)
{
    info.metallic = u_MetallicFactor;
    info.perceptualRoughness = u_RoughnessFactor;

#ifdef HAS_METALLIC_ROUGHNESS_MAP
    // Roughness is stored in the 'g' channel, metallic is stored in the 'b' channel.
    // This layout intentionally reserves the 'r' channel for (optional) occlusion map data
    vec4 mrSample = texture(u_MetallicRoughnessSampler, getMetallicRoughnessUV());
    info.perceptualRoughness *= mrSample.g;
    info.metallic *= mrSample.b;
#endif

    // Achromatic f0 based on IOR.
    vec3 f0 = vec3(f0_ior);

    info.albedoColor = mix(info.baseColor.rgb * (vec3(1.0) - f0),  vec3(0), info.metallic);
    info.f0 = mix(f0, info.baseColor.rgb, info.metallic);

    return info;
}

MaterialInfo getSheenInfo(MaterialInfo info)
{
    info.sheenColorFactor = u_SheenColorFactor;
    info.sheenRoughnessFactor = u_SheenRoughnessFactor;

    #ifdef HAS_SHEEN_COLOR_MAP
        vec4 sheenColorSample = texture(u_SheenColorSampler, getSheenColorUV());
        info.sheenColorFactor *= sheenColorSample.rgb;
    #endif

    #ifdef HAS_SHEEN_ROUGHNESS_MAP
        vec4 sheenRoughnessSample = texture(u_SheenRoughnessSampler, getSheenRoughnessUV());
        info.sheenRoughnessFactor *= sheenRoughnessSample.a;
    #endif

    return info;
}

#ifdef MATERIAL_TRANSMISSION
MaterialInfo getTransmissionInfo(MaterialInfo info)
{
    info.transmissionFactor = u_TransmissionFactor;

    #ifdef HAS_TRANSMISSION_MAP
        vec4 transmissionSample = texture(u_TransmissionSampler, getTransmissionUV());
        info.transmissionFactor *= transmissionSample.r;
    #endif

    return info;
}
#endif

MaterialInfo getClearCoatInfo(MaterialInfo info, NormalInfo normalInfo, float f0_ior)
{
    info.clearcoatFactor = u_ClearcoatFactor;
    info.clearcoatRoughness = u_ClearcoatRoughnessFactor;
    info.clearcoatF0 = vec3(f0_ior);
    info.clearcoatF90 = vec3(1.0);

    #ifdef HAS_CLEARCOAT_TEXTURE_MAP
        vec4 clearcoatSample = texture(u_ClearcoatSampler, getClearcoatUV());
        info.clearcoatFactor *= clearcoatSample.r;
    #endif

    #ifdef HAS_CLEARCOAT_ROUGHNESS_MAP
        vec4 clearcoatSampleRoughness = texture(u_ClearcoatRoughnessSampler, getClearcoatRoughnessUV());
        info.clearcoatRoughness *= clearcoatSampleRoughness.g;
    #endif


    info.clearcoatNormal = getClearcoatNormal(normalInfo);


    info.clearcoatRoughness = clamp(info.clearcoatRoughness, 0.0, 1.0);

    return info;
}

float albedoSheenScalingLUT(float NdotV, float sheenRoughnessFactor)
{
    return texture(u_SheenELUT, vec2(NdotV, sheenRoughnessFactor)).r;
}

void main()
{
    vec4 baseColor = getBaseColor();

#ifdef ALPHAMODE_OPAQUE
    baseColor.a = 1.0;
#endif

#ifdef MATERIAL_UNLIT
    g_finalColor = (vec4(linearTosRGB(baseColor.rgb), baseColor.a));
    return;
#endif

    vec3 v = normalize(u_Camera - v_Position);
    NormalInfo normalInfo = getNormalInfo(v);
    vec3 n = normalInfo.n;
    vec3 t = normalInfo.t;
    vec3 b = normalInfo.b;

    float NdotV = clampedDot(n, v);
    float TdotV = clampedDot(t, v);
    float BdotV = clampedDot(b, v);

    MaterialInfo materialInfo;
    materialInfo.baseColor = baseColor.rgb;

    // The default index of refraction of 1.5 yields a dielectric normal incidence reflectance of 0.04.
    float ior = 1.5;
    float f0_ior = 0.04;

#ifdef MATERIAL_SPECULARGLOSSINESS
    materialInfo = getSpecularGlossinessInfo(materialInfo);
#endif

#ifdef MATERIAL_METALLICROUGHNESS
    materialInfo = getMetallicRoughnessInfo(materialInfo, f0_ior);
#endif

#ifdef MATERIAL_SHEEN
    materialInfo = getSheenInfo(materialInfo);
#endif

#ifdef MATERIAL_CLEARCOAT
    materialInfo = getClearCoatInfo(materialInfo, normalInfo, f0_ior);
#endif

#ifdef MATERIAL_TRANSMISSION
    materialInfo = getTransmissionInfo(materialInfo);
#endif
    materialInfo.perceptualRoughness = clamp(materialInfo.perceptualRoughness, 0.0, 1.0);
    materialInfo.metallic = clamp(materialInfo.metallic, 0.0, 1.0);

    // Roughness is authored as perceptual roughness; as is convention,
    // convert to material roughness by squaring the perceptual roughness.
    materialInfo.alphaRoughness = materialInfo.perceptualRoughness * materialInfo.perceptualRoughness;

    // Compute reflectance.
    float reflectance = max(max(materialInfo.f0.r, materialInfo.f0.g), materialInfo.f0.b);

    // Anything less than 2% is physically impossible and is instead considered to be shadowing. Compare to "Real-Time-Rendering" 4th editon on page 325.
    materialInfo.f90 = vec3(clamp(reflectance * 50.0, 0.0, 1.0));

    materialInfo.n = n;

    // LIGHTING
    vec3 f_specular = vec3(0.0);
    vec3 f_diffuse = vec3(0.0);
    vec3 f_emissive = vec3(0.0);
    vec3 f_clearcoat = vec3(0.0);
    vec3 f_sheen = vec3(0.0);
    vec3 f_transmission = vec3(0.0);

    float albedoSheenScaling = 1.0;

    // Calculate lighting contribution from image based lighting source (IBL)
#ifdef USE_IBL
    f_specular += getIBLRadianceGGX(n, v, materialInfo.perceptualRoughness, materialInfo.f0);
    f_diffuse += getIBLRadianceLambertian(n, materialInfo.albedoColor);

    #ifdef MATERIAL_CLEARCOAT
        f_clearcoat += getIBLRadianceGGX(materialInfo.clearcoatNormal, v, materialInfo.clearcoatRoughness, materialInfo.clearcoatF0);
    #endif

    #ifdef MATERIAL_SHEEN
        f_sheen += getIBLRadianceCharlie(n, v, materialInfo.sheenRoughnessFactor, materialInfo.sheenColorFactor);
    #endif

#endif

#if defined(MATERIAL_TRANSMISSION) && (defined(USE_PUNCTUAL) || defined(USE_IBL))
    vec2 normalizedFragCoord = vec2(0.0,0.0);
    normalizedFragCoord.x = gl_FragCoord.x/float(u_ScreenSize.x);
    normalizedFragCoord.y = gl_FragCoord.y/float(u_ScreenSize.y);

    f_transmission += materialInfo.transmissionFactor * getIBLRadianceTransmission(n, u_Camera - v_Position, normalizedFragCoord, materialInfo.perceptualRoughness, materialInfo.baseColor, materialInfo.f0, materialInfo.f90);
#endif
    float ao = 1.0;
    // Apply optional PBR terms for additional (optional) shading
#ifdef HAS_OCCLUSION_MAP
    ao = texture(u_OcclusionSampler,  getOcclusionUV()).r;
    f_diffuse = mix(f_diffuse, f_diffuse * ao, u_OcclusionStrength);
    // apply ambient occlusion too all lighting that is not punctual
    f_specular = mix(f_specular, f_specular * ao, u_OcclusionStrength);
    f_sheen = mix(f_sheen, f_sheen * ao, u_OcclusionStrength);
    f_clearcoat = mix(f_clearcoat, f_clearcoat * ao, u_OcclusionStrength);
#endif

#ifdef USE_PUNCTUAL
    for (int i = 0; i < LIGHT_COUNT; ++i)
    {
        Light light = u_Lights[i];

        vec3 pointToLight = -light.direction;
        float rangeAttenuation = 1.0;
        float spotAttenuation = 1.0;

        if(light.type != LightType_Directional)
        {
            pointToLight = light.position - v_Position;
        }

        // Compute range and spot light attenuation.
        if (light.type != LightType_Directional)
        {
            rangeAttenuation = getRangeAttenuation(light.range, length(pointToLight));
        }
        if (light.type == LightType_Spot)
        {
            spotAttenuation = getSpotAttenuation(pointToLight, light.direction, light.outerConeCos, light.innerConeCos);
        }

        vec3 intensity = rangeAttenuation * spotAttenuation * light.intensity * light.color;

        vec3 l = normalize(pointToLight);   // Direction from surface point to light
        vec3 h = normalize(l + v);          // Direction of the vector between l and v, called halfway vector
        float NdotL = clampedDot(n, l);
        float NdotV = clampedDot(n, v);
        float NdotH = clampedDot(n, h);
        float LdotH = clampedDot(l, h);
        float VdotH = clampedDot(v, h);

        if (NdotL > 0.0 || NdotV > 0.0)
        {
            // Calculation of analytical light
            // https://github.com/KhronosGroup/glTF/tree/master/specification/2.0#acknowledgments AppendixB
            f_diffuse += intensity * NdotL *  BRDF_lambertian(materialInfo.f0, materialInfo.f90, materialInfo.albedoColor, VdotH);
            f_specular += intensity * NdotL * BRDF_specularGGX(materialInfo.f0, materialInfo.f90, materialInfo.alphaRoughness, VdotH, NdotL, NdotV, NdotH);

            #ifdef MATERIAL_SHEEN
                f_sheen += intensity * getPunctualRadianceSheen(materialInfo.sheenColorFactor, materialInfo.sheenRoughnessFactor, NdotL, NdotV, NdotH);
                albedoSheenScaling = min(1.0 - max3(materialInfo.sheenColorFactor) * albedoSheenScalingLUT(NdotV, materialInfo.sheenRoughnessFactor),
                    1.0 - max3(materialInfo.sheenColorFactor) * albedoSheenScalingLUT(NdotL, materialInfo.sheenRoughnessFactor));
            #endif

            #ifdef MATERIAL_CLEARCOAT
                f_clearcoat += intensity * getPunctualRadianceClearCoat(materialInfo.clearcoatNormal, v, l, h, VdotH,
                    materialInfo.clearcoatF0, materialInfo.clearcoatF90, materialInfo.clearcoatRoughness);
            #endif
        }

        #ifdef MATERIAL_TRANSMISSION
            f_transmission += intensity * getPunctualRadianceTransmission(n, v, l, materialInfo.alphaRoughness, materialInfo.f0, materialInfo.f90, materialInfo.transmissionFactor, materialInfo.baseColor);
        #endif
    }
#endif // !USE_PUNCTUAL

    f_emissive = u_EmissiveFactor;
#ifdef HAS_EMISSIVE_MAP
    f_emissive *= texture(u_EmissiveSampler, getEmissiveUV()).rgb;
#endif

    vec3 color = vec3(0);

    ///
    /// Layer blending
    ///

    float clearcoatFactor = 0.0;
    vec3 clearcoatFresnel = vec3(0.0);

    #ifdef MATERIAL_CLEARCOAT
        clearcoatFactor = materialInfo.clearcoatFactor;
        clearcoatFresnel = F_Schlick(materialInfo.clearcoatF0, materialInfo.clearcoatF90, clampedDot(materialInfo.clearcoatNormal, v));
        // account for masking
        f_clearcoat = f_clearcoat * clearcoatFactor;
    #endif

    #ifdef MATERIAL_TRANSMISSION
        vec3 diffuse = mix(f_diffuse, f_transmission, materialInfo.transmissionFactor);
    #else
        vec3 diffuse = f_diffuse;
    #endif

    color = f_emissive + diffuse + f_specular;
    color = f_sheen + color * albedoSheenScaling;
    color = color * (1.0 - clearcoatFactor * clearcoatFresnel) + f_clearcoat;

#ifndef DEBUG_OUTPUT // no debug

#ifdef ALPHAMODE_MASK
    // Late discard to avaoid samplig artifacts. See https://github.com/KhronosGroup/glTF-Sample-Viewer/issues/267
    if(baseColor.a < u_AlphaCutoff)
    {
        discard;
    }
    baseColor.a = 1.0;
#endif

    // regular shading
    g_finalColor = vec4(toneMap(color), baseColor.a);

#else // debug output

    #ifdef DEBUG_METALLIC
        g_finalColor.rgb = vec3(materialInfo.metallic);
    #endif

    #ifdef DEBUG_ROUGHNESS
        g_finalColor.rgb = vec3(materialInfo.perceptualRoughness);
    #endif

    #ifdef DEBUG_NORMAL
        #ifdef HAS_NORMAL_MAP
            g_finalColor.rgb = texture(u_NormalSampler, getNormalUV()).rgb;
        #else
            g_finalColor.rgb = vec3(0.5, 0.5, 1.0);
        #endif
    #endif

    #ifdef DEBUG_GEOMETRY_NORMAL
        g_finalColor.rgb = (normalInfo.ng + 1.0) / 2.0;
    #endif

    #ifdef DEBUG_WORLDSPACE_NORMAL
        g_finalColor.rgb = (n + 1.0) / 2.0;
    #endif

    #ifdef DEBUG_TANGENT
        g_finalColor.rgb = t * 0.5 + vec3(0.5);
    #endif

    #ifdef DEBUG_BITANGENT
        g_finalColor.rgb = b * 0.5 + vec3(0.5);
    #endif

    #ifdef DEBUG_BASECOLOR
        g_finalColor.rgb = linearTosRGB(materialInfo.baseColor);
    #endif

    #ifdef DEBUG_OCCLUSION
        g_finalColor.rgb = vec3(ao);
    #endif

    #ifdef DEBUG_F0
        g_finalColor.rgb = materialInfo.f0;
    #endif

    #ifdef DEBUG_FEMISSIVE
        g_finalColor.rgb = linearTosRGB(f_emissive);
    #endif

    #ifdef DEBUG_FSPECULAR
        g_finalColor.rgb = linearTosRGB(f_specular);
    #endif

    #ifdef DEBUG_FDIFFUSE
        g_finalColor.rgb = linearTosRGB(f_diffuse);
    #endif

    #ifdef DEBUG_FCLEARCOAT
        g_finalColor.rgb = linearTosRGB(f_clearcoat);
    #endif

    #ifdef DEBUG_FSHEEN
        g_finalColor.rgb = linearTosRGB(f_sheen);
    #endif

    #ifdef DEBUG_FTRANSMISSION
        g_finalColor.rgb = linearTosRGB(f_transmission);
    #endif

    #ifdef DEBUG_ALPHA
        g_finalColor.rgb = vec3(baseColor.a);
    #endif

    g_finalColor.a = 1.0;

#endif // !DEBUG_OUTPUT
}
