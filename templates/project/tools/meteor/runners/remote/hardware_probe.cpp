#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dlfcn.h>
#include <string>
#include <vector>

#include "acl/acl.h"
#include "tiling/platform/platform_ascendc.h"

namespace {

void JsonString(const char* text)
{
    std::putchar('"');
    if (text != nullptr) {
        for (const unsigned char* p = reinterpret_cast<const unsigned char*>(text); *p != 0; ++p) {
            switch (*p) {
            case '\\': std::printf("\\\\"); break;
            case '"': std::printf("\\\""); break;
            case '\n': std::printf("\\n"); break;
            case '\r': std::printf("\\r"); break;
            case '\t': std::printf("\\t"); break;
            default:
                if (*p < 0x20) std::printf("\\u%04x", *p);
                else std::putchar(*p);
            }
        }
    }
    std::putchar('"');
}

void JsonNullableString(const char* value)
{
    if (value != nullptr && value[0] != 0) JsonString(value);
    else std::printf("null");
}

const char* TrySocName()
{
    using Fn = const char* (*)();
    void* symbol = dlsym(RTLD_DEFAULT, "aclrtGetSocName");
    if (symbol == nullptr) return nullptr;
    return reinterpret_cast<Fn>(symbol)();
}

bool GetAttr(uint32_t device, aclrtDevAttr attr, int64_t* value)
{
    return aclrtGetDeviceInfo(device, attr, value) == ACL_SUCCESS;
}


std::string ArchToString(NpuArch arch)
{
    uint32_t value = static_cast<uint32_t>(arch);
    if (value == static_cast<uint32_t>(NpuArch::DAV_RESV) || value == 0) return "";
    char buffer[32];
    std::snprintf(buffer, sizeof(buffer), "dav-%u", value);
    return std::string(buffer);
}

std::string TryNpuArch(const char* soc, const char** reason)
{
    if (soc == nullptr || soc[0] == 0) {
        *reason = "soc_version unavailable";
        return "";
    }
    auto* platform = platform_ascendc::PlatformAscendCManager::GetInstance();
    if (platform == nullptr) {
        *reason = "PlatformAscendCManager returned null";
        return "";
    }
    std::string arch = ArchToString(platform->GetCurNpuArch());
    if (arch.empty()) {
        *reason = "GetCurNpuArch returned reserved or unknown arch";
        return "";
    }
    *reason = nullptr;
    return arch;
}

bool GetMemory(size_t* freeBytes, size_t* totalBytes)
{
    return aclrtGetMemInfo(ACL_HBM_MEM, freeBytes, totalBytes) == ACL_SUCCESS;
}

}  // namespace

int main()
{
    aclError init = aclInit(nullptr);
    if (init != ACL_SUCCESS) {
        std::printf("{\"status\":\"FAILED\",\"reason\":\"aclInit failed\",\"acl_error\":%d}\n", static_cast<int>(init));
        return 1;
    }

    uint32_t count = 0;
    aclError countStatus = aclrtGetDeviceCount(&count);
    std::printf("{\"status\":");
    JsonString(countStatus == ACL_SUCCESS ? "READY" : "FAILED");
    std::printf(",\"device_count\":%u,\"devices\":[", countStatus == ACL_SUCCESS ? count : 0);
    if (countStatus == ACL_SUCCESS) {
        for (uint32_t device = 0; device < count; ++device) {
            if (device != 0) std::printf(",");
            aclError setStatus = aclrtSetDevice(static_cast<int32_t>(device));
            const char* soc = setStatus == ACL_SUCCESS ? TrySocName() : nullptr;
            const char* socReason = setStatus == ACL_SUCCESS ? "aclrtGetSocName unavailable" : "aclrtSetDevice failed";
            const char* archReason = nullptr;
            std::string npuArch = setStatus == ACL_SUCCESS ? TryNpuArch(soc, &archReason) : std::string();
            int64_t cube = 0;
            bool hasCube = setStatus == ACL_SUCCESS && GetAttr(device, ACL_DEV_ATTR_CUBE_CORE_NUM, &cube);
            size_t freeBytes = 0;
            size_t totalBytes = 0;
            bool hasMemory = setStatus == ACL_SUCCESS && GetMemory(&freeBytes, &totalBytes);
            std::printf("{\"device_id\":%u,\"name\":", device);
            JsonNullableString(soc);
            std::printf(",\"name_reason\":");
            if (soc != nullptr && soc[0] != 0) std::printf("null"); else JsonString(socReason);
            std::printf(",\"soc_version\":");
            JsonNullableString(soc);
            std::printf(",\"soc_version_reason\":");
            if (soc != nullptr && soc[0] != 0) std::printf("null"); else JsonString(socReason);
            std::printf(",\"npu_arch\":");
            if (!npuArch.empty()) JsonString(npuArch.c_str()); else std::printf("null");
            std::printf(",\"npu_arch_reason\":");
            if (!npuArch.empty()) std::printf("null"); else JsonString(archReason != nullptr ? archReason : "GetCurNpuArch unavailable");
            std::printf(",\"cube_core_count\":");
            if (hasCube) std::printf("%lld", static_cast<long long>(cube));
            else std::printf("null");
            std::printf(",\"memory\":{\"total_bytes\":");
            if (hasMemory) std::printf("%llu", static_cast<unsigned long long>(totalBytes));
            else std::printf("null");
            std::printf(",\"free_bytes\":");
            if (hasMemory) std::printf("%llu", static_cast<unsigned long long>(freeBytes));
            else std::printf("null");
            std::printf(",\"reason\":");
            if (hasMemory) std::printf("null"); else JsonString("aclrtGetMemInfo(ACL_HBM_MEM) failed");
            std::printf("},\"health\":{\"status\":null,\"reason\":\"health query requires npu-smi raw log\"}");
            if (setStatus == ACL_SUCCESS) aclrtResetDevice(static_cast<int32_t>(device));
            std::printf("}");
        }
    }
    std::printf("],\"cann\":{\"runtime\":null,\"runtime_reason\":\"not exposed by ACL probe\",\"compiler\":null,\"compiler_reason\":\"reported by command logs\"}}\n");
    aclFinalize();
    return countStatus == ACL_SUCCESS ? 0 : 1;
}
